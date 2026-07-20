import { sha256 } from '@noble/hashes/sha2.js'
import mime from 'mime'
import { Base93Encoder } from 'libp2r2p/base93'
import NMMR from 'nmmr'
import { bytesToBase16 } from 'libp2r2p/base16'
import { relayPool as nostrRelays } from 'libp2r2p/relay'
import { APP_FILE_CHUNK_BYTES } from '#constants/app-file.js'
import { warnAssetSizeMismatch } from '#helpers/asset-size.js'

const HEAD_TIMEOUT_AFTER_FIRST_MS = 500

function parseContentLength (value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return null
  const size = Number(text)
  return Number.isSafeInteger(size) ? size : null
}

function chunksForSize (size) {
  return Math.max(1, Math.ceil(size / APP_FILE_CHUNK_BYTES))
}

export function isMimeTypeAccepted (expectedMimeType, contentTypeHeader) {
  if (!expectedMimeType) return true
  const serverMediaType = (contentTypeHeader || '').split(';')[0].trim().toLowerCase()
  if (!serverMediaType || serverMediaType === 'application/octet-stream') return true
  const serverExt = mime.getExtension(serverMediaType)
  const expectedExt = mime.getExtension(expectedMimeType)
  if (serverExt && expectedExt && serverExt === expectedExt) return true
  return serverMediaType.split('/')[0] === expectedMimeType.split('/')[0]
}

/**
 * Downloads a file from Blossom servers and produces local kind 34601
 * pseudo-events (unsigned and never published).
 * file chunk events compatible with the existing IRFS storage format.
 *
 * Unlike the IRFS approach which uses an NMMR merkle tree, here we use the
 * Blossom file's own sha256 hash as the local pseudo-root.
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
    this.mimeType = options.mimeType ?? null
    this.size = options.size ?? null
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
        await this.callback({
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
    const { chosenServer, headByteLengths } = await this.#queryHeadFromAllServers(blossomServers)
    const serversToTry = [chosenServer, ...blossomServers.filter(s => s !== chosenServer)]

    for (const serverUrl of serversToTry) {
      if (this.signal?.aborted) throw new Error('Aborted')
      const response = await this.#fetchFromServer(serverUrl)
      if (!response) continue
      await this.#downloadResponse(serverUrl, response, headByteLengths.get(serverUrl) ?? null)
      return
    }

    throw new Error(`File ${this.fileHash} not found on any blossom server`)
  }

  async #fetchFromServer (serverUrl) {
    try {
      const response = await fetch(`${serverUrl}/${this.fileHash}`, {
        method: 'GET',
        signal: this.signal
      })
      if (!response.ok || !response.body) return null
      if (!isMimeTypeAccepted(this.mimeType, response.headers.get('Content-Type'))) return null
      return response
    } catch (error) {
      if (error.name === 'AbortError') throw error
      return null
    }
  }

  async #downloadResponse (serverUrl, response, headByteLength) {
    const getByteLength = parseContentLength(response.headers.get('Content-Length'))
    const manifestByteLength = Number.isSafeInteger(this.size) && this.size >= 0 ? this.size : null
    const provisionalByteLength = getByteLength ?? headByteLength ?? manifestByteLength
    const provisionalTotal = provisionalByteLength === null ? null : chunksForSize(provisionalByteLength)
    const first = await this.#consumeBody(response.body, provisionalTotal)

    if (first.hash !== this.fileHash) throw new Error('Blossom content hash mismatch')
    warnAssetSizeMismatch({
      service: 'blossom',
      root: this.fileHash,
      advertisedSize: manifestByteLength,
      actualSize: first.byteLength
    })
    warnAssetSizeMismatch({
      service: 'blossom',
      root: this.fileHash,
      advertisedSize: getByteLength,
      actualSize: first.byteLength,
      source: 'GET Content-Length'
    })
    warnAssetSizeMismatch({
      service: 'blossom',
      root: this.fileHash,
      advertisedSize: headByteLength,
      actualSize: first.byteLength,
      source: 'HEAD Content-Length'
    })

    if (provisionalTotal === first.totalChunks) {
      await this.#reportComplete(first)
      return
    }

    if (provisionalTotal !== null) {
      await this.callback({
        type: 'reset',
        discardChunks: true,
        root: this.fileHash
      })
    }

    const retry = await this.#fetchFromServer(serverUrl)
    if (!retry) throw new Error('Failed to replay Blossom download with observed chunk total')
    const second = await this.#consumeBody(retry.body, first.totalChunks)
    if (second.hash !== this.fileHash || second.totalChunks !== first.totalChunks || second.byteLength !== first.byteLength) {
      throw new Error('Blossom content changed while replaying download')
    }
    await this.#reportComplete(second)
  }

  async #reportComplete ({ totalChunks, byteLength }) {
    await this.callback({
      type: 'progress',
      progress: 100,
      count: totalChunks,
      total: totalChunks,
      byteLength
    })
  }

  /**
   * Queries all servers concurrently for HEAD.
   * After the first successful response, waits briefly for other servers and
   * uses their optional Content-Length values only to choose a preferred server.
   */
  async #queryHeadFromAllServers (blossomServers) {
    const results = [] // { serverUrl, byteLength }
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
          results.push({
            serverUrl,
            byteLength: parseContentLength(headRes.headers.get('Content-Length'))
          })
          if (!firstResolved) {
            firstResolved = true
            // Give the remaining servers a short chance to provide metadata.
            setTimeout(timeoutResolve, HEAD_TIMEOUT_AFTER_FIRST_MS)
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
      return { chosenServer: blossomServers[0], headByteLengths: new Map() }
    }

    // Majority vote on Content-Length
    const counts = new Map()
    for (const { byteLength } of results) {
      if (byteLength === null) continue
      counts.set(byteLength, (counts.get(byteLength) ?? 0) + 1)
    }
    let bestByteLength = null
    let bestCount = 0
    for (const [byteLength, count] of counts) {
      if (count > bestCount) {
        bestByteLength = byteLength
        bestCount = count
      }
    }

    // Prefer a server that reported the winning Content-Length
    const chosenServer = bestByteLength === null
      ? results[0].serverUrl
      : results.find(result => result.byteLength === bestByteLength)?.serverUrl ?? results[0].serverUrl
    return {
      chosenServer,
      headByteLengths: new Map(results.map(result => [result.serverUrl, result.byteLength]))
    }
  }

  async #consumeBody (body, totalChunks) {
    const reader = body.getReader()
    let buffer = new Uint8Array(0)
    let chunkIndex = 0
    let processedCount = 0
    let receivedBytes = 0
    const hasher = sha256.create()

    try {
      while (true) {
        if (this.signal?.aborted) throw new Error('Aborted')

        const { done, value } = await reader.read()
        if (done) break
        receivedBytes += value.length
        hasher.update(value)

        // Accumulate bytes and emit each full CHUNK_SIZE immediately
        const newBuffer = new Uint8Array(buffer.length + value.length)
        newBuffer.set(buffer)
        newBuffer.set(value, buffer.length)
        buffer = newBuffer

        while (buffer.length >= APP_FILE_CHUNK_BYTES) {
          const chunk = buffer.slice(0, APP_FILE_CHUNK_BYTES)
          buffer = buffer.slice(APP_FILE_CHUNK_BYTES)

          processedCount++
          if (totalChunks !== null && chunkIndex < totalChunks) {
            const event = this.#createChunkEvent(chunk, chunkIndex, totalChunks)
            await this.callback({
              type: 'progress',
              progress: Math.min(99, (processedCount / totalChunks) * 100),
              count: processedCount,
              total: totalChunks,
              chunkIndex,
              event
            })
          }
          chunkIndex++
        }
      }
    } finally {
      reader.releaseLock()
    }

    // Emit the remaining bytes (last partial chunk)
    if (buffer.length > 0 || receivedBytes === 0) {
      processedCount++
      // A partial chunk is valid only when it is the provisional last chunk.
      // If the hint predicted too many chunks, wait for the authenticated
      // replay instead of persisting an event that cannot pass local checks.
      if (totalChunks !== null && chunkIndex === totalChunks - 1) {
        const event = this.#createChunkEvent(buffer, chunkIndex, totalChunks)
        await this.callback({
          type: 'progress',
          progress: Math.min(99, (processedCount / totalChunks) * 100),
          count: processedCount,
          total: totalChunks,
          chunkIndex,
          event
        })
      }
      chunkIndex++
    }

    return {
      byteLength: receivedBytes,
      hash: bytesToBase16(hasher.digest()),
      totalChunks: chunksForSize(receivedBytes)
    }
  }

  /**
   * Creates an unsigned, local-only kind 34601 event from a raw byte slice.
   *
   * Uses the Blossom file SHA-256 hash as the local pseudo-root,
   * matching what countFileChunksFromDb and saveFileChunksToDB expect when
   * looking up chunks by rootHash = fileHash from the bundle file tag.
   */
  #createChunkEvent (bytes, chunkIndex, totalChunks) {
    const dTagValue = NMMR.deriveChunkId(this.fileHash, chunkIndex)

    // This is a synthetic event format for the chunk, not actually signed or published to relays.
    const event = {
      kind: 34601,
      pubkey: this.pubkey,
      tags: [
        ['d', dTagValue],
        ['mmr', String(chunkIndex), String(totalChunks), '']
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
    const { result: events } = await nostrRelays.getEvents(
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
