import NMMR from 'nmmr'
import { sha256 } from '@noble/hashes/sha2.js'
import Base93Encoder from '#services/base93-encoder.js'
import { bytesToBase16 } from '#helpers/base16.js'
import nostrRelays from '#services/nostr-relays.js'

const CHUNK_SIZE = 51000

/**
 * Downloads a file from Blossom servers and produces kind 34600 (unsigned)
 * file chunk events compatible with the existing IRFS storage format.
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

    let response = null
    for (const serverUrl of blossomServers) {
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

    await this.#streamToChunkEvents(response.body)
  }

  async #streamToChunkEvents (body) {
    const nmmr = new NMMR()
    const reader = body.getReader()
    let buffer = new Uint8Array(0)
    let chunkCount = 0

    try {
      while (true) {
        if (this.signal?.aborted) throw new Error('Aborted')

        const { done, value } = await reader.read()
        if (done) break

        // Accumulate bytes and split into CHUNK_SIZE pieces
        const newBuffer = new Uint8Array(buffer.length + value.length)
        newBuffer.set(buffer)
        newBuffer.set(value, buffer.length)
        buffer = newBuffer

        while (buffer.length >= CHUNK_SIZE) {
          const chunk = buffer.slice(0, CHUNK_SIZE)
          buffer = buffer.slice(CHUNK_SIZE)
          await nmmr.append(chunk)
          chunkCount++
        }
      }

      // Remaining bytes
      if (buffer.length > 0) {
        await nmmr.append(buffer)
        chunkCount++
      }
    } finally {
      reader.releaseLock()
    }

    if (chunkCount === 0) return

    // Now iterate over NMMR chunks and create kind 34600 events
    let processedCount = 0
    for await (const chunk of nmmr.getChunks()) {
      if (this.signal?.aborted) throw new Error('Aborted')

      const event = this.#createChunkEvent(chunk, chunkCount)
      processedCount++

      this.callback({
        type: 'progress',
        progress: (processedCount / chunkCount) * 100,
        count: processedCount,
        total: chunkCount,
        chunkIndex: chunk.index,
        event
      })
    }
  }

  /**
   * Creates an unsigned kind 34600 event from an NMMR chunk.
   * Includes pubkey and computed event id but no signature.
   * Matches the format expected by saveFileChunksToDB.
   */
  #createChunkEvent (chunk, totalChunks) {
    const event = {
      kind: 34600,
      pubkey: this.pubkey,
      tags: [
        // Caveat: if same chunk is present multiple times on the same file,
        // the d tag will be the same while the c tag will differ instead
        // of a single event with that d tag featuring multiple c tags.
        // This is not an issue for counting and storing chunks
        // considering current IndexedDB schema.
        ['d', chunk.x],
        ['c', `${chunk.rootX}:${chunk.index}`, String(totalChunks), ...chunk.proof]
      ],
      content: new Base93Encoder().update(chunk.contentBytes).getEncoded(),
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
