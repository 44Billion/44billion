import nostrRelays from '#services/nostr-relays.js'
const BATCH_SIZE = 40

/**
 * FileDownloader
 *
 * A high-performance, resilient service for downloading file chunks from multiple Nostr relays.
 *
 * Why it's fast:
 * - Parallel & Distributed: Connects to multiple relays simultaneously.
 * - Smart Striding: Assigns non-contiguous chunks to different relays (e.g., Relay A gets 0, 2, 4... Relay B gets 1, 3, 5...) to maximize aggregate bandwidth without redundancy.
 * - Pipelining: Triggers the next batch of requests early (when 50% of the current batch is received) to eliminate latency gaps between roundtrips.
 * - Adaptive Load Balancing: Idle relays "steal" in-flight chunks from busy relays to speed up the final phase of the download.
 * - Resilient Fallback: If a relay fails to deliver specific chunks, they are dynamically reassigned to other available relays.
 * - Dynamic State Management: Tracks "in-flight", "downloaded", and "missing" chunks in real-time to ensure full file reconstruction with minimal duplication.
 */
export default class FileDownloader {
  constructor (fileRootHash, pubkeysByRelay, callback, options = {}) {
    options = Object.assign({ abortOnFailure: true }, options)

    this.fileRootHash = fileRootHash
    this.pubkeysByRelay = pubkeysByRelay
    this.callback = callback
    this.downloadedChunkIndexes = new Set(options.downloadedChunkIndexes || [])
    this.totalChunks = options.totalChunks && Number.isInteger(options.totalChunks) && options.totalChunks > 0 ? options.totalChunks : null

    this.relayStates = new Map()
    let relayLength = 0
    for (const url of Object.keys(pubkeysByRelay)) {
      relayLength++
      this.relayStates.set(url, {
        url,
        activeBatches: 0,
        missingIndexes: new Set(),
        assignedIndexes: new Set()
      })
    }

    this.inFlightIndexes = new Set()
    this.maxTempTotal = BATCH_SIZE * relayLength
    this.isRunning = false
    this.resolveRun = null
    this.abortOnFailure = !!options.abortOnFailure
    this.abortController = null
  }

  async run () {
    if (this.isRunning) return
    this.isRunning = true
    this.abortController = new AbortController()

    if (this.totalChunks && this.downloadedChunkIndexes.size > 0) {
      this._reportProgress()
    }

    if (this.totalChunks && this.downloadedChunkIndexes.size >= this.totalChunks) {
      this.isRunning = false
      return
    }

    const { promise, resolve } = Promise.withResolvers()
    this.resolveRun = resolve

    this._triggerAll()

    await promise
    this.isRunning = false
  }

  _reportProgress (extraData = {}) {
    const total = this.totalChunks || 0
    const count = this.downloadedChunkIndexes.size
    const progress = total > 0 ? (count / total) * 100 : 0

    this.callback({
      type: 'progress',
      progress,
      count,
      total: this.totalChunks,
      ...extraData
    })
  }

  _triggerAll () {
    for (const state of this.relayStates.values()) {
      this._manageRelay(state)
    }
  }

  _manageRelay (state) {
    if (!this.isRunning) return
    if (this._isComplete()) {
      this._finish()
      return
    }

    if (state.activeBatches >= 2) {
      // console.log(`Relay ${state.url} saturated (activeBatches: ${state.activeBatches})`)
      return
    }

    const batchIndexes = this._getBatch(state)

    if (batchIndexes.length === 0) {
      // console.log(`Relay ${state.url} has no work available`)
      if (this._isExhausted()) {
        console.log('Download exhausted, finishing...')
        this._finish()
      }
      return
    }

    batchIndexes.forEach(i => {
      this.inFlightIndexes.add(i)
      state.assignedIndexes.add(i)
    })
    this._processBatch(state, batchIndexes)
  }

  _getBatch (state) {
    const effectiveTotal = this.totalChunks || this.maxTempTotal
    const neededIndexes = []

    // 1. Primary pass: Find chunks that are not downloaded and NOT in-flight (fresh work)
    for (let i = 0; i < effectiveTotal; i++) {
      if (this.downloadedChunkIndexes.has(i)) continue
      if (this.inFlightIndexes.has(i)) continue
      if (state.missingIndexes.has(i)) continue
      neededIndexes.push(i)
    }

    // 2. Secondary pass: If no fresh work, help with in-flight chunks (redundancy/stealing)
    if (neededIndexes.length === 0) {
      for (let i = 0; i < effectiveTotal; i++) {
        if (this.downloadedChunkIndexes.has(i)) continue
        if (!this.inFlightIndexes.has(i)) continue // We want to steal in-flight ones
        if (state.missingIndexes.has(i)) continue
        if (state.assignedIndexes.has(i)) continue
        neededIndexes.push(i)
      }
      // if (neededIndexes.length > 0) {
      //   console.log(`[${state.url}] Stealing ${neededIndexes.length} in-flight chunks`)
      // }
    }

    if (neededIndexes.length === 0) return []

    const viableRelays = []
    const relayKeys = Array.from(this.relayStates.keys()).sort()

    for (const url of relayKeys) {
      const rs = this.relayStates.get(url)
      const canDownloadSomething = neededIndexes.some(idx => !rs.missingIndexes.has(idx))
      if (canDownloadSomething) {
        viableRelays.push(url)
      }
    }

    if (viableRelays.length === 0) return []

    const myIndex = viableRelays.indexOf(state.url)
    if (myIndex === -1 && viableRelays.length > 0) {
      return []
    }

    let batch = []

    if (viableRelays.length === 1) {
      batch = neededIndexes.slice(0, BATCH_SIZE)
    } else {
      const primary = []
      const secondary = []

      for (const idx of neededIndexes) {
        if (idx % viableRelays.length === myIndex) {
          if (primary.length < BATCH_SIZE) primary.push(idx)
        } else {
          if (secondary.length < BATCH_SIZE) secondary.push(idx)
        }

        if (primary.length >= BATCH_SIZE && secondary.length >= BATCH_SIZE) break
      }

      batch = primary.slice(0, BATCH_SIZE)
      if (batch.length < BATCH_SIZE) {
        batch = batch.concat(secondary.slice(0, BATCH_SIZE - batch.length))
      }
    }

    return batch
  }

  async _processBatch (state, indexes) {
    console.log(`Requesting batch from ${state.url}: indexes ${indexes.join(', ')}`)
    state.activeBatches++

    const filter = {
      kinds: [34600],
      authors: this.pubkeysByRelay[state.url],
      '#c': indexes.map(i => `${this.fileRootHash}:${i}`)
    }

    let countReceived = 0
    let halfBatchTriggered = false
    const receivedIndexes = new Set()

    try {
      const generator = nostrRelays.getEventsGenerator(filter, [state.url], { signal: this.abortController?.signal })

      for await (const { event, type } of generator) {
        if (!this.isRunning) break
        if (type === 'error') continue
        if (!event) continue

        const cTag = event.tags.find(t => t[0] === 'c' && t[1].startsWith(this.fileRootHash + ':'))
        if (!cTag) continue

        const parts = cTag[1].split(':')
        const index = parseInt(parts[1])
        if (isNaN(index) || index < 0 || index >= 100000 /* ~5GB */) continue

        if (cTag.length < 3) continue
        const total = parseInt(cTag[2])
        if (isNaN(total) || total <= 0 || total > 100000) continue

        if (this.totalChunks !== null && this.totalChunks !== total) continue

        if (this.totalChunks === null) {
          this.totalChunks = total
        }

        if (this.downloadedChunkIndexes.has(index)) continue

        this.downloadedChunkIndexes.add(index)
        receivedIndexes.add(index)
        this.inFlightIndexes.delete(index)

        countReceived++

        this._reportProgress({ chunkIndex: index, event, relay: state.url })

        if (!halfBatchTriggered && countReceived >= Math.ceil(indexes.length / 2)) {
          halfBatchTriggered = true
          Promise.resolve().then(() => this._manageRelay(state))
        }
      }
    } catch (err) {
      if (err.message !== 'Aborted') {
        console.error('Batch error', err)
      }
    } finally {
      state.activeBatches--

      for (const i of indexes) {
        state.assignedIndexes.delete(i)

        if (this.totalChunks !== null && i >= this.totalChunks) {
          this.inFlightIndexes.delete(i)
          continue
        }

        if (!receivedIndexes.has(i)) {
          if (!this.downloadedChunkIndexes.has(i)) {
            console.log(`Marking chunk ${i} as missing from relay ${state.url}`)
            state.missingIndexes.add(i)
            this.inFlightIndexes.delete(i)

            const allMiss = Array.from(this.relayStates.values()).every(s => s.missingIndexes.has(i))
            if (allMiss) {
              if (this.totalChunks === null) {
                // Should not happen if at least one chunk was found
                // If checking blindly without total, we ignore missing errors
                continue
              }
              this._reportProgress({ error: new Error('Missing file chunk'), chunkIndex: i })
              if (this.abortOnFailure) {
                this.abortController?.abort()
                this._finish()
                break
              }
            }
          }
        }
      }

      this._triggerAll()
    }
  }

  _isComplete () {
    if (this.totalChunks !== null && this.downloadedChunkIndexes.size >= this.totalChunks) return true
    return false
  }

  _isExhausted () {
    if (this.inFlightIndexes.size > 0) return false

    for (const s of this.relayStates.values()) {
      if (s.activeBatches > 0) return false
      if (this._getBatch(s).length > 0) return false
    }

    return true
  }

  _finish () {
    if (this.resolveRun) {
      this.resolveRun()
      this.resolveRun = null
    }
  }
}
