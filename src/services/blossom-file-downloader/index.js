import { sha256 } from '@noble/hashes/sha2.js'
import Base93Encoder from '#services/base93-encoder.js'
import { bytesToBase16 } from '#helpers/base16.js'
import nostrRelays from '#services/nostr-relays.js'

const CHUNK_SIZE = 51000
const HEAD_TIMEOUT_AFTER_FIRST_MS = 500

/**
 * Downloads a file from Blossom servers and produces kind 34600 (unsigned)
 * file chunk events compatible with the existing IRFS storage format.
 *
 * Unlike the IRFS approach which uses an NMMR merkle tree, here we use the
 * blossom file's own sha256 hash as the "root hash" in the c tags.
 * This means countFileChunksFromDb / streamFileChunksFromDb work correctly
 * since the bundle file tag also references the same sha256 hash.
 *
 * This allows the rest of the codebase to treat blossom-hosted files exactly
 * like relay-hosted files once they are cached locally.
 */
export default class BlossomFileDownloader {
  constructor (fileHash, pubkey, writeRelays, callback, options = {}) {
    this.fileHash = fileHash
    this.pubkey = pubkey
    this.writeRelays = writeRelays
    this.callback = callback
    this.signal = options.signal ?? null
    this.isRunning = false
  }

  async run () {
    if (this.isRunning) return this.runPromise
    this.isRunning = true

    const { promise, resolve } = Promise.withResolvers()
    this.runPromise = promise
    this.resolveRun = resolve

    try {
      await this.#download()
    } catch (err) {
      if (err.name !== 'AbortError' && err.message !== 'Aborted') {
        this.callback({
          type: 'progress',
          progress: 0,
          count: 0,
          total: 0,
          error: err
        })
      }
    } finally {
      this.isRunning = false
      this.resolveRun()
    }
  }

  async #download () {
    const blossomServers = await this.#getBlossomServers()
    if (blossomServers.length === 0) {
      throw new Error('No blossom servers found for the app publisher')
    }

    // Query all servers for HEAD simultaneously.
    // Start a 500ms timeout after the first server responds with a valid Content-Length.
    // Pick the most common Content-Length (majority vote) or the first valid one.
    const { totalChunks, chosenServer } = await this.#queryHeadFromAllServers(blossomServers)

    if (!chosenServer) {
      throw new Error(`File ${this.fileHash} not found on any blossom server`)
    }

    // Stream the file content, trying the chosen server first then others
    let response = null
    const serversToTry = [chosenServer, ...blossomServers.filter(s => s !== chosenServer)]

    for (const serverUrl of serversToTry) {
      if (this.signal?.aborted) throw new Error('Aborted')

      try {
        const url = `${serverUrl}/${this.fileHash}`
        const res = await fetch(url, {
          method: 'GET',
          signal: this.signal
        })
        if (res.ok && res.body) {
          response = res
          break
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err
        // Try next server
      }
    }

    if (!response) {
      throw new Error(`File ${this.fileHash} not found on any blossom server`)
    }

    await this.#streamToChunkEvents(response.body, totalChunks)
  }

  /**
   * Queries all servers concurrently for HEAD.
   * As soon as the first server responds with a valid Content-Length, a 500ms
   * timeout is started. At the end, picks the most common Content-Length value
   * (majority vote); falls back to the first valid response.
   * Returns { totalChunks, chosenServer }.
   */
  async #queryHeadFromAllServers (blossomServers) {
    const results = [] // { serverUrl, contentLength }
    let firstResolved = false
    let timeoutResolve = null
    const timeoutPromise = new Promise(resolve => { timeoutResolve = resolve })

    const headPromises = blossomServers.map(async serverUrl => {
      if (this.signal?.aborted) return

      try {
        const url = `${serverUrl}/${this.fileHash}`
        const headRes = await fetch(url, {
          method: 'HEAD',
          signal: this.signal
        })
        if (headRes.ok) {
          const contentLengthHeader = headRes.headers.get('Content-Length')
          if (contentLengthHeader !== null) {
            const byteLength = parseInt(contentLengthHeader, 10)
            if (!Number.isNaN(byteLength) && byteLength >= 0) {
              results.push({ serverUrl, byteLength })
              if (!firstResolved) {
                firstResolved = true
                // Start the 500ms timeout so remaining servers have a chance
                setTimeout(timeoutResolve, HEAD_TIMEOUT_AFTER_FIRST_MS)
              }
            }
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          // Swallow abort for individual HEAD requests - the overall abort is handled elsewhere
        }
        // Ignore errors from individual servers
      }
    })

    // Race: either all responses collected or timeout fires after first response
    await Promise.race([
      Promise.all(headPromises),
      timeoutPromise.then(() => Promise.all(headPromises.map(p => Promise.race([p, Promise.resolve()]))))
    ])

    if (results.length === 0) {
      return { totalChunks: null, chosenServer: null }
    }

    // Majority vote on Content-Length
    const counts = new Map()
    for (const { byteLength } of results) {
      counts.set(byteLength, (counts.get(byteLength) ?? 0) + 1)
    }
    let bestByteLength = results[0].byteLength
    let bestCount = 1
    for (const [byteLength, count] of counts) {
      if (count > bestCount || (count === bestCount && byteLength === results[0].byteLength)) {
        bestByteLength = byteLength
        bestCount = count
      }
    }

    const totalChunks = Math.max(1, Math.ceil(bestByteLength / CHUNK_SIZE))
    // Prefer a server that reported the winning Content-Length
    const chosenServer = results.find(r => r.byteLength === bestByteLength)?.serverUrl ?? results[0].serverUrl

    return { totalChunks, chosenServer }
  }

  async #streamToChunkEvents (body, totalChunks) {
    const reader = body.getReader()
    let buffer = new Uint8Array(0)
    let chunkIndex = 0
    let processedCount = 0

    try {
      while (true) {
        if (this.signal?.aborted) throw new Error('Aborted')

        const { done, value } = await reader.read()
        if (done) break

        // Accumulate bytes and emit each full CHUNK_SIZE immediately
        const newBuffer = new Uint8Array(buffer.length + value.length)
        newBuffer.set(buffer)
        newBuffer.set(value, buffer.length)
        buffer = newBuffer

        while (buffer.length >= CHUNK_SIZE) {
          const chunk = buffer.slice(0, CHUNK_SIZE)
          buffer = buffer.slice(CHUNK_SIZE)

          const event = this.#createChunkEvent(chunk, chunkIndex, totalChunks)
          processedCount++
          this.callback({
            type: 'progress',
            progress: (processedCount / totalChunks) * 100,
            count: processedCount,
            total: totalChunks,
            chunkIndex,
            event
          })
          chunkIndex++
        }
      }
    } finally {
      reader.releaseLock()
    }

    // Emit the remaining bytes (last partial chunk)
    if (buffer.length > 0) {
      const event = this.#createChunkEvent(buffer, chunkIndex, totalChunks)
      processedCount++
      this.callback({
        type: 'progress',
        progress: (processedCount / totalChunks) * 100,
        count: processedCount,
        total: totalChunks,
        chunkIndex,
        event
      })
      chunkIndex++
    }

    // Report any missing chunks if the stream ended before totalChunks were received
    if (totalChunks !== null && chunkIndex < totalChunks) {
      const missing = []
      for (let i = chunkIndex; i < totalChunks; i++) missing.push(i)
      this.callback({
        type: 'progress',
        progress: (processedCount / totalChunks) * 100,
        count: processedCount,
        total: totalChunks,
        error: new Error('Missing file chunks'),
        chunkIndexes: missing
      })
    }
  }

  /**
   * Creates an unsigned kind 34600 event from a raw byte slice.
   *
   * Uses the blossom file sha256 hash as the "root hash" in the c tag,
   * matching what countFileChunksFromDb and saveFileChunksToDB expect when
   * looking up chunks by rootHash = fileHash from the bundle file tag.
   */
  #createChunkEvent (bytes, chunkIndex, totalChunks) {
    // Use fileHash:chunkIndex as deterministic chunk identity for the d tag
    const dTagValue = `${this.fileHash}:${chunkIndex}`

    // This is a synthetic event format for the chunk, not actually signed or published to relays.
    const event = {
      kind: 34600,
      pubkey: this.pubkey,
      tags: [
        ['d', dTagValue],
        // c tag: rootHash:position, totalChunks — using fileHash as root
        // No merkle proof elements since there's no merkle tree
        ['c', `${this.fileHash}:${chunkIndex}`, String(totalChunks)]
      ],
      content: new Base93Encoder().update(bytes).getEncoded(),
      created_at: Math.floor(Date.now() / 1000)
    }

    // Compute event id (NIP-01: sha256 of serialized event)
    const serialized = JSON.stringify([
      0,
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags,
      event.content
    ])
    event.id = bytesToBase16(sha256(new TextEncoder().encode(serialized)))

    return event
  }

  /**
   * Fetches the publisher's blossom server list from their kind 10063 event.
   */
  async #getBlossomServers () {
    const relays = [...new Set(this.writeRelays)]
    const { result: events } = await nostrRelays.getEventsAsap(
      { kinds: [10063], authors: [this.pubkey], limit: 1 },
      relays,
      { signal: this.signal }
    )

    if (!events || events.length === 0) return []

    events.sort((a, b) => b.created_at - a.created_at)
    const best = events[0]

    return (best.tags ?? [])
      .filter(t => Array.isArray(t) && t[0] === 'server' && /^https?:\/\//.test(t[1]))
      .map(t => t[1].trim().replace(/\/$/, ''))
      .filter(Boolean)
  }
}
