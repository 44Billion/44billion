import { freeRelays } from 'libp2r2p/relay'
import { nfileDecode } from 'libp2r2p/nip19'

import { APP_FILE_CHUNK_BYTES } from '#constants/app-file.js'
import { getUserRelays } from '#helpers/nostr-queries.js'
import { isValidRelayUrl } from '#helpers/relay.js'
import {
  findAnyLocalChunk,
  findLocalChunk,
  subscribeChunkArrivals
} from '#services/idb/browser/queries/chunk-cache.js'
import { parseIrfsChunkEvent } from '#services/irfs-chunk.js'
import FileDownloader from '#services/file-downloader/index.js'

const DEFAULT_TIMEOUT_MS = 30_000
const STREAM_WINDOW_CHUNKS = 256
const CACHE_CONCURRENCY = 4
const CACHE_QUEUE_LIMIT = STREAM_WINDOW_CHUNKS + CACHE_CONCURRENCY

export class NFileNotFoundError extends Error {
  constructor () {
    super('Nfile chunks not found')
    this.name = 'NFileNotFoundError'
    this.code = 'NFILE_NOT_FOUND'
  }
}

class SlidingArrivalTimeout {
  constructor (milliseconds) {
    this.milliseconds = milliseconds
    this.deadline = Date.now() + milliseconds
    this.waiters = new Set()
  }

  note () {
    this.deadline = Date.now() + this.milliseconds
    for (const resolve of this.waiters) resolve(true)
    this.waiters.clear()
    return true
  }

  async wait (signal) {
    if (signal?.aborted) return false
    const remaining = this.deadline - Date.now()
    if (remaining <= 0) return false
    return new Promise(resolve => {
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiters.delete(finish)
        resolve(value)
      }
      const onAbort = () => finish(false)
      const timer = setTimeout(() => finish(false), remaining)
      timer.unref?.()
      this.waiters.add(finish)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  close () {
    for (const resolve of this.waiters) resolve(false)
    this.waiters.clear()
  }
}

function uniqueValidRelays (values) {
  return [...new Set(values
    .filter(value => typeof value === 'string')
    .map(value => value.trim().replace(/\/+$/, ''))
    .filter(isValidRelayUrl))]
}

function safeMime (value) {
  return typeof value === 'string' &&
    value.length <= 255 &&
    /^[\x21-\x7e]+\/[\x21-\x7e]+$/.test(value) &&
    !/[\r\n]/.test(value)
    ? value
    : 'application/octet-stream'
}

function contentDisposition (filename) {
  if (typeof filename !== 'string' || filename.length === 0 || /[\0\r\n]/.test(filename)) return 'inline'
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `inline; filename*=UTF-8''${encoded}`
}

function responseHeaders ({ contentLength, contentRange, mime, filename }) {
  const headers = {
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Disposition',
    'content-disposition': contentDisposition(filename),
    'content-length': String(contentLength),
    'content-type': safeMime(mime)
  }
  if (contentRange) headers['content-range'] = contentRange
  return headers
}

export function parseSingleByteRange (header, byteLength) {
  if (header == null || header === '') return { start: 0, end: byteLength - 1, partial: false }
  if (typeof header !== 'string' || !header.startsWith('bytes=') || header.includes(',')) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2]) || byteLength <= 0) return null

  let start
  let end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    start = Math.max(0, byteLength - suffix)
    end = byteLength - 1
  } else {
    start = Number(match[1])
    if (!Number.isSafeInteger(start) || start >= byteLength) return null
    if (!match[2]) {
      end = byteLength - 1
    } else {
      end = Number(match[2])
      if (!Number.isSafeInteger(end) || end < start) return null
      end = Math.min(end, byteLength - 1)
    }
  }
  return { start, end, partial: true }
}

export default class NFileDownloader {
  constructor (entity, {
    activeOwner,
    cacheEvent,
    fallbackRelays = freeRelays,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    _FileDownloader = FileDownloader,
    _findAnyLocalChunk = findAnyLocalChunk,
    _findLocalChunk = findLocalChunk,
    _getUserRelays = getUserRelays,
    _subscribeChunkArrivals = subscribeChunkArrivals,
    signal
  } = {}) {
    this.reference = typeof entity === 'string' ? nfileDecode(entity) : entity
    if (!this.reference || !/^[0-9a-f]{64}$/.test(this.reference.root || '')) throw new Error('Invalid nfile reference')
    this.FileDownloaderClass = _FileDownloader
    this.getUserRelays = _getUserRelays
    this.findAnyLocalChunk = _findAnyLocalChunk
    this.findLocalChunk = _findLocalChunk
    this.subscribeChunkArrivals = _subscribeChunkArrivals
    this.activeOwner = activeOwner
    this.cacheEvent = cacheEvent
    this.fallbackRelays = uniqueValidRelays(fallbackRelays || [])
    this.abortController = new AbortController()
    this.signal = signal ? AbortSignal.any([signal, this.abortController.signal]) : this.abortController.signal
    this.arrivals = new SlidingArrivalTimeout(timeoutMs)
    this.transientChunks = new Map()
    this.cacheActive = 0
    this.cacheDisabled = false
    this.cacheQueue = []
    this.cacheWaiters = new Set()
    this.activeDownloaders = new Set()
    this.unsubscribe = null
    this.relayMap = null
    this.localOnly = false
    this.closed = false
    this.total = null
  }

  async open ({ method = 'GET', range, localOnly = false } = {}) {
    method = String(method).toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') throw new Error('Unsupported nfile method')
    this.localOnly = localOnly === true
    this.unsubscribe = this.subscribeChunkArrivals(this.reference.root, ({ newRootIndex }) => {
      if (newRootIndex) this.arrivals.note()
    })

    const discovered = await this.#discoverTotal()
    if (!discovered) return this.#notFoundResponse()
    const { total } = discovered
    this.total = total
    const last = discovered.index === total - 1 ? discovered : await this.#getChunk(total - 1, { wait: true })
    if (!last) return this.#notFoundResponse()

    const byteLength = ((total - 1) * APP_FILE_CHUNK_BYTES) + last.contentBytes.byteLength
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return this.#notFoundResponse()
    const parsedRange = parseSingleByteRange(range, byteLength)
    if (!parsedRange) {
      return {
        status: 416,
        headers: responseHeaders({
          contentLength: 0,
          contentRange: `bytes */${byteLength}`,
          mime: this.reference.mime,
          filename: this.reference.filename
        }),
        body: null,
        close: () => this.close()
      }
    }

    const contentLength = parsedRange.end - parsedRange.start + 1
    const status = parsedRange.partial ? 206 : 200
    const headers = responseHeaders({
      contentLength,
      contentRange: parsedRange.partial ? `bytes ${parsedRange.start}-${parsedRange.end}/${byteLength}` : null,
      mime: this.reference.mime,
      filename: this.reference.filename
    })
    if (method === 'HEAD') {
      await this.#waitForCacheQueue()
      return { status, headers, body: null, close: () => this.close() }
    }

    try {
      await this.#ensureByteRange(parsedRange.start, parsedRange.end)
    } catch (error) {
      if (error instanceof NFileNotFoundError) return this.#notFoundResponse()
      throw error
    }

    return {
      status,
      headers,
      body: this.#streamByteRange(parsedRange.start, parsedRange.end),
      close: () => this.close()
    }
  }

  #notFoundResponse () {
    return {
      status: 404,
      headers: { 'access-control-allow-origin': '*', 'content-length': '0' },
      body: null,
      close: () => this.close()
    }
  }

  async #relayPubkeysByUrl () {
    if (this.localOnly) return {}
    if (this.relayMap) return this.relayMap
    const relayHints = uniqueValidRelays(this.reference.relays || [])
    let relays = [...relayHints]
    if (this.reference.author) {
      try {
        const result = await this.getUserRelays([this.reference.author])
        relays.push(...(result?.[this.reference.author]?.write || []))
      } catch {}
      if (relays.length === 0) relays.push(...this.fallbackRelays)
    } else {
      relays.push(...this.fallbackRelays)
    }
    relays = uniqueValidRelays(relays)
    this.relayMap = Object.fromEntries(relays.map(url => [
      url,
      this.reference.author ? [this.reference.author] : undefined
    ]))
    return this.relayMap
  }

  async #discoverTotal () {
    let chunk = await this.findAnyLocalChunk(this.reference.root, { preferredOwner: this.activeOwner })
    if (chunk) return chunk

    const relayMap = await this.#relayPubkeysByUrl()
    if (Object.keys(relayMap).length > 0) {
      let discovered = null
      const downloader = new this.FileDownloaderClass(
        this.reference.root,
        relayMap,
        data => {
          if (!data.event || discovered) return
          const parsed = parseIrfsChunkEvent(data.event, { root: this.reference.root })
          discovered = { ...parsed, event: data.event }
          this.#acceptNetworkChunk(discovered)
          downloader.abort()
        },
        {
          abortOnFailure: false,
          fallbackToAnyAuthor: !!this.reference.author,
          signal: this.signal
        }
      )
      await this.#runDownloader(downloader)
      if (discovered) return discovered
    }

    while (await this.arrivals.wait(this.signal)) {
      chunk = await this.findAnyLocalChunk(this.reference.root, { preferredOwner: this.activeOwner })
      if (chunk) return chunk
    }
    return null
  }

  async #getChunk (index, { wait = false } = {}) {
    const transient = this.transientChunks.get(index)
    if (transient) return transient
    let local = await this.findLocalChunk(this.reference.root, index, { preferredOwner: this.activeOwner })
    if (local) return local
    if (!wait) return null

    await this.#downloadRange(index, index, new Map())
    if (this.transientChunks.has(index)) return this.transientChunks.get(index)
    local = await this.findLocalChunk(this.reference.root, index, { preferredOwner: this.activeOwner })
    if (local) return local

    while (await this.arrivals.wait(this.signal)) {
      local = await this.findLocalChunk(this.reference.root, index, { preferredOwner: this.activeOwner })
      if (local) return local
      if (this.transientChunks.has(index)) return this.transientChunks.get(index)
    }
    return null
  }

  async #ensureByteRange (startByte, endByte) {
    const firstIndex = Math.floor(startByte / APP_FILE_CHUNK_BYTES)
    const lastIndex = Math.floor(endByte / APP_FILE_CHUNK_BYTES)
    for (let start = firstIndex; start <= lastIndex; start += STREAM_WINDOW_CHUNKS) {
      const end = Math.min(lastIndex, start + STREAM_WINDOW_CHUNKS - 1)
      const chunks = await this.#loadWindow(start, end)
      if (chunks.size !== end - start + 1) throw new NFileNotFoundError()
      await this.#waitForCacheQueue()
      for (const index of chunks.keys()) {
        if (index !== firstIndex && index !== lastIndex) this.transientChunks.delete(index)
      }
    }
  }

  async * #streamByteRange (startByte, endByte) {
    const firstIndex = Math.floor(startByte / APP_FILE_CHUNK_BYTES)
    const lastIndex = Math.floor(endByte / APP_FILE_CHUNK_BYTES)
    try {
      for (let start = firstIndex; start <= lastIndex; start += STREAM_WINDOW_CHUNKS) {
        const end = Math.min(lastIndex, start + STREAM_WINDOW_CHUNKS - 1)
        const chunks = await this.#loadWindow(start, end)
        if (chunks.size !== end - start + 1) throw new NFileNotFoundError()
        for (let index = start; index <= end; index++) {
          const chunk = chunks.get(index)
          let from = 0
          let to = chunk.contentBytes.byteLength
          if (index === firstIndex) from = startByte % APP_FILE_CHUNK_BYTES
          if (index === lastIndex) to = (endByte % APP_FILE_CHUNK_BYTES) + 1
          yield chunk.contentBytes.slice(from, to)
          this.transientChunks.delete(index)
        }
      }
    } finally {
      this.close()
    }
  }

  async #loadWindow (start, end) {
    const chunks = new Map()
    for (let index = start; index <= end; index++) {
      const chunk = await this.#getChunk(index)
      if (chunk) chunks.set(index, chunk)
    }
    if (chunks.size < end - start + 1) await this.#downloadRange(start, end, chunks)

    const refresh = async () => {
      for (let index = start; index <= end; index++) {
        if (chunks.has(index)) continue
        const transient = this.transientChunks.get(index)
        const local = transient || await this.findLocalChunk(this.reference.root, index, { preferredOwner: this.activeOwner })
        if (local) chunks.set(index, local)
      }
    }
    await refresh()
    while (chunks.size < end - start + 1 && await this.arrivals.wait(this.signal)) await refresh()
    if (chunks.size < end - start + 1) throw new NFileNotFoundError()
    return chunks
  }

  async #downloadRange (start, end, cachedChunks) {
    const relayMap = await this.#relayPubkeysByUrl()
    if (Object.keys(relayMap).length === 0) return
    const downloadedIndexes = [...cachedChunks.keys()]
    const downloader = new this.FileDownloaderClass(
      this.reference.root,
      relayMap,
      data => {
        if (!data.event) return
        const parsed = parseIrfsChunkEvent(data.event, { root: this.reference.root })
        this.#acceptNetworkChunk({ ...parsed, event: data.event })
        cachedChunks.set(parsed.index, { ...parsed, event: data.event })
      },
      {
        abortOnFailure: false,
        downloadedCount: downloadedIndexes.length,
        endIndex: end,
        fallbackToAnyAuthor: !!this.reference.author,
        loadDownloadedChunkIndexes: async ({ start: rangeStart, end: rangeEnd }) =>
          downloadedIndexes.filter(index => index >= rangeStart && index <= rangeEnd),
        signal: this.signal,
        startIndex: start,
        totalChunks: this.total
      }
    )
    await this.#runDownloader(downloader)
  }

  async #runDownloader (downloader) {
    this.activeDownloaders.add(downloader)
    try {
      await downloader.run()
    } finally {
      this.activeDownloaders.delete(downloader)
    }
  }

  #acceptNetworkChunk (chunk) {
    if (this.total != null && chunk.total !== this.total) return false
    this.total ??= chunk.total
    const isNew = !this.transientChunks.has(chunk.index)
    this.transientChunks.set(chunk.index, chunk)
    if (isNew) this.arrivals.note()
    this.#queueCacheEvent(chunk.event)
    return true
  }

  #queueCacheEvent (event) {
    if (this.cacheDisabled || typeof this.cacheEvent !== 'function') return
    if (this.cacheActive + this.cacheQueue.length >= CACHE_QUEUE_LIMIT) return
    this.cacheQueue.push(event)
    this.#pumpCacheQueue()
  }

  #pumpCacheQueue () {
    while (!this.cacheDisabled && this.cacheActive < CACHE_CONCURRENCY && this.cacheQueue.length > 0) {
      const event = this.cacheQueue.shift()
      this.cacheActive++
      Promise.resolve()
        .then(() => this.cacheEvent(event))
        .catch(() => {
          this.cacheDisabled = true
          this.cacheQueue.length = 0
        })
        .finally(() => {
          this.cacheActive--
          this.#pumpCacheQueue()
          this.#resolveCacheWaitersIfIdle()
        })
    }
    this.#resolveCacheWaitersIfIdle()
  }

  #resolveCacheWaitersIfIdle () {
    if (this.cacheActive > 0 || this.cacheQueue.length > 0) return
    for (const resolve of this.cacheWaiters) resolve()
    this.cacheWaiters.clear()
  }

  #waitForCacheQueue () {
    if (this.cacheActive === 0 && this.cacheQueue.length === 0) return Promise.resolve()
    if (this.signal.aborted) return Promise.resolve()
    return new Promise(resolve => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        this.cacheWaiters.delete(finish)
        this.signal.removeEventListener('abort', finish)
        resolve()
      }
      this.cacheWaiters.add(finish)
      this.signal.addEventListener('abort', finish, { once: true })
    })
  }

  close () {
    if (this.closed) return
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.arrivals.close()
    this.abortController.abort()
    for (const downloader of this.activeDownloaders) downloader.abort?.()
    this.activeDownloaders.clear()
  }
}
