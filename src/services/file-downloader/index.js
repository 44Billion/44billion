import nostrRelays from '#services/nostr-relays.js'

// Untried indexes are those that have not yet been added to a batch by anyone else.
// In-flight indexes are still being downloaded by someone else; they are not in the untried indexes;
// they are asc sorted by number of people downloading them
export function getBatchIndexes ({ batchSize, untriedIndexes, orderedInFlightIndexes, step, offset }) {
  const selectedIndexes = [/* { idx, wasUntried } */]
  const availableIndexesGroups = [untriedIndexes, orderedInFlightIndexes]
    .filter(v => v.length > 0)

  while (availableIndexesGroups.length > 0) {
    const availableIndexes = availableIndexesGroups.shift()
    const isUntried = availableIndexes === untriedIndexes
    let currentOffset = isUntried
      // A different offset argument for each consumer prevents all of them
      // from selecting the same indexes when they start
      ? offset
      // Start from the first index for ordered in-flight indexes
      : 0
    const effectiveStep = isUntried
      ? step // Round-robin for untried
      : 1 // For ordered in-flight, we want to check every contiguous index
    const offsetLimit = currentOffset + effectiveStep

    while ((selectedIndexes.length < batchSize) && (currentOffset < offsetLimit)) {
      // forward
      for (let i = currentOffset; i < availableIndexes.length; i += effectiveStep) {
        selectedIndexes.push({ idx: availableIndexes[i], wasUntried: isUntried })

        if (selectedIndexes.length >= batchSize) break
      }

      // rewind, because if initial offset was > 0, it wouldn't try first position(s)
      if (selectedIndexes.length < batchSize) {
        const start = currentOffset % effectiveStep
        for (let i = start; i < currentOffset; i += effectiveStep) {
          selectedIndexes.push({ idx: availableIndexes[i], wasUntried: isUntried })

          if (selectedIndexes.length >= batchSize) break
        }
      }

      currentOffset++
    }
  }

  return selectedIndexes
}

export default class FileDownloader {
  constructor (fileRootHash, pubkeysByRelay, callback, options = {}) {
    const abortOnFailure = options.abortOnFailure ?? true
    let abortSignal = null
    let onFailureAbortController = null
    if (abortOnFailure) {
      onFailureAbortController = new AbortController()
      abortSignal = AbortSignal.any([options.signal, onFailureAbortController.signal].filter(Boolean))
    }
    const relayStates = new Map()
    let relayOffset = 0
    for (const url of Object.keys(pubkeysByRelay)) {
      relayStates.set(url, {
        url,
        offset: relayOffset++,
        activeBatches: 0,
        triedIndexes: new Set()
      })
    }

    const batchSize = options.batchSize ?? 20
    // This is effectively limited to 3 and kicks in just when needed the most (see halfBatchTriggered flag)
    // to eliminate round-trip bottlenecks while avoiding relay ratelimits triggering
    const maxRelayParallelBatches = Math.max(1, Math.min(options.maxRelayParallelBatches ?? 3, 3))
    const totalChunks =
      options.totalChunks &&
      Number.isInteger(options.totalChunks) &&
      options.totalChunks > 0
        ? options.totalChunks
        : null
    const tempTotalChunks = totalChunks === null ? batchSize * relayStates.size : null
    const maxTotalChunks = totalChunks ?? 100000 // ~5GB

    const downloadedChunkIndexes = new Set(options.downloadedChunkIndexes || [])
    const downloadedCount = downloadedChunkIndexes.size
    if (downloadedCount > 0 && options.totalChunks == null) {
      throw new Error(
        'totalChunks must be provided if downloadedChunkIndexes is provided' +
        ' or else the downloader may report missing chunks for trying indexes above the total chunks that actually exist'
      )
    }

    // May use tempTotalChunks if we haven't downloaded any chunks yet.
    // Any chunk should carry the total chunks info
    const effectiveTotalChunks = totalChunks ?? tempTotalChunks
    const missingIndexes = new Set(
      Array
        .from({ length: effectiveTotalChunks }, (_, i) => i)
        .filter(i => !downloadedChunkIndexes.has(i))
    )

    Object.assign(this, {
      debug: options.debug ?? false,
      missingIndexes,
      downloadedCount,
      batchSize,
      maxRelayParallelBatches,
      totalChunks,
      tempTotalChunks,
      maxTotalChunks,
      fileRootHash,
      pubkeysByRelay,
      callback,
      onFailureAbortController,
      abortSignal,
      // idx => count of how many relays are currently downloading this index
      inFlightIndexCounters: new Map(),
      relayStates,
      activeBatches: 0,
      isRunning: false,
      shouldGracefullyAbortRemainingBatches: false
    })
  }

  async run () {
    if (this.isRunning) return this.runPromise

    this.isRunning = true
    ;({ promise: this.runPromise, resolve: this.resolveRun } = Promise.withResolvers())

    if (this.totalChunks && this.downloadedCount > 0) {
      // Report initial progress if we already have some chunks downloaded,
      // so the caller knows the total chunks and can display progress right away
      this.reportProgress()
    }

    if (this.totalChunks && this.downloadedCount >= this.totalChunks) {
      this.isRunning = false
      return
    }

    for (const relayState of this.relayStates.values()) {
      try {
        this.downloadFromRelay(relayState) // don't await, run in parallel
      } catch (err) {
        console.error(`Failed to start download from relay ${relayState.url}:`, err)
        const wasAborted = this.maybeAbort(err)
        if (wasAborted) break
      }
    }

    return this.runPromise
  }

  // Set it as soon as we receive a valid chunk
  setTotalChunks (totalChunks) {
    const diff = this.tempTotalChunks ? totalChunks - this.tempTotalChunks : 0
    this.totalChunks = totalChunks
    const previousTotalChunks = this.tempTotalChunks
    this.tempTotalChunks = null

    if (!diff) return

    this.maxTotalChunks = totalChunks
    this.fixMissingIndexes(diff, previousTotalChunks)
  }

  fixMissingIndexes (diff, previousTotalChunks) {
    if (diff > 0) this.missingIndexes = new Set([...this.missingIndexes, ...Array.from({ length: diff }, (_, i) => i + previousTotalChunks)].sort((a, b) => a - b))
    else if (diff < 0) this.missingIndexes = new Set([...this.missingIndexes].filter(i => i < this.totalChunks))
  }

  async downloadFromRelay (relayState) {
    const untriedIndexes = this.getUntriedIndexes(relayState)
    const availableInFlightIndexes = this.getAvailableInflightIndexes(relayState)
    if (untriedIndexes.length === 0 && availableInFlightIndexes.length === 0) return this.maybeFinish()

    try {
      this.activeBatches++
      relayState.activeBatches++

      const batchIndexes = getBatchIndexes({
        batchSize: this.batchSize,
        untriedIndexes,
        orderedInFlightIndexes: availableInFlightIndexes,
        step: this.relayStates.size,
        offset: relayState.offset
      })

      if (batchIndexes.length > 0) {
        for (const { idx, wasUntried } of batchIndexes) {
          // The "wasUntried" var means not tried by anyone.
          // Even when false it wasn't tried by this relay yet,
          // that's why we add it to triedIndexes in any case
          relayState.triedIndexes.add(idx)
          if (wasUntried) {
            this.inFlightIndexCounters.set(idx, 1)
          } else {
            // Stealing an in-flight index from another relay, just increment the counter
            this.inFlightIndexCounters.set(idx, this.inFlightIndexCounters.get(idx) + 1)
          }
        }

        await this.downloadBatch(relayState, batchIndexes.map(b => b.idx))
      }
    } catch (err) {
      if (err.message === 'Aborted') {
        console.log('Download from relay aborted:', relayState.url)
        this.finish()
      } else if (!this.shouldGracefullyAbortRemainingBatches) {
        console.error('Batch error', err)
      }
    } finally {
      this.activeBatches--
      relayState.activeBatches--
      this.maybeFinish()
    }
  }

  getUntriedIndexes (relayState) {
    return Array.from(this.missingIndexes).filter(idx => {
      if (relayState.triedIndexes.has(idx)) return false
      const inFlightCount = this.inFlightIndexCounters.get(idx) || 0
      if (inFlightCount > 0) return false
      return true
    })
  }

  getAvailableInflightIndexes (relayState) {
    return Array.from(this.inFlightIndexCounters.keys())
      .filter(idx => !relayState.triedIndexes.has(idx))
      .sort((a, b) => (this.inFlightIndexCounters.get(a) || 0) - (this.inFlightIndexCounters.get(b) || 0))
  }

  async downloadBatch (relayState, indexes) {
    const limit = indexes.length
    const filter = {
      kinds: [34600],
      authors: this.pubkeysByRelay[relayState.url],
      '#c': indexes.map(i => `${this.fileRootHash}:${i}`),
      limit
    }
    const generator = nostrRelays.getEventsGenerator(filter, [relayState.url], { signal: this.abortSignal })

    let eventMeta
    let halfBatchTriggered = false
    let rawReceivedCount = 0
    const receivedIndexes = []
    for await (const { event, type } of generator) {
      if (!this.isRunning) break
      if (type === 'event') rawReceivedCount++
      if (rawReceivedCount > limit) break

      // If more than half of the batch is received, trigger another batch to keep the pipeline full,
      // but only if there aren't many batches already in flight for this relay to avoid overloading it
      if (
        !halfBatchTriggered &&
        (indexes.length > 1 || this.batchSize === 1) &&
        relayState.activeBatches < this.maxRelayParallelBatches &&
        rawReceivedCount >= Math.ceil(indexes.length / 2) &&
        this.missingIndexes.size > 0
      ) {
        halfBatchTriggered = true
        this.downloadFromRelay(relayState)
      }

      if (
        type === 'error' ||
        !event ||
        !(eventMeta = this.isValidChunk(event))
      ) continue

      if (this.totalChunks === null) this.setTotalChunks(eventMeta.total)

      // Skip if already processed
      if (!this.missingIndexes.has(eventMeta.index)) continue

      this.downloadedCount++
      this.missingIndexes.delete(eventMeta.index)
      receivedIndexes.push(eventMeta.index)

      const inflightCount = this.inFlightIndexCounters.get(eventMeta.index)
      if (inflightCount > 1) this.inFlightIndexCounters.set(eventMeta.index, inflightCount - 1)
      else this.inFlightIndexCounters.delete(eventMeta.index)

      this.reportProgress({ chunkIndex: eventMeta.index, event, relay: relayState.url })
    }
    // At the end of this batch, maybe trigger another batch too
    if (
      (relayState.activeBatches - 1) < this.maxRelayParallelBatches &&
      this.missingIndexes.size > 0
    ) this.downloadFromRelay(relayState)

    for (const i of indexes) {
      if (!this.missingIndexes.has(i)) continue

      const inflightCount = this.inFlightIndexCounters.get(i)
      if (inflightCount > 1) this.inFlightIndexCounters.set(i, inflightCount - 1)
      else this.inFlightIndexCounters.delete(i)

      // Don't report missing chunks if we don't know the real total chunks yet,
      // as they might not exist and we don't want to trigger false alarms
      // However, index 0 is guaranteed to exist
      if (this.totalChunks === null && i > 0) continue

      if (
        (this.inFlightIndexCounters.get(i) ?? 0) > 0 ||
        // This checks if some haven't tried.
        // However "tried" in fact means picked, but the download itself may not have been attempted yet,
        // so we also need to check if there are in-flight downloads for this index
        Array.from(this.relayStates.values()).some(s => !s.triedIndexes.has(i))
      ) continue

      const error = new Error('Missing file chunk')
      this.reportProgress({ error, chunkIndex: i })
      const wasAborted = this.maybeAbort(error)
      if (wasAborted) return
    }
  }

  maybeAbort (err) {
    if (!this.abortOnFailure || err.message === 'Aborted') return false

    console.log('Aborting file download due to error:', err)
    this.onFailureAbortController.abort()
    this.finish()
    return true
  }

  reportProgress (extraData = {}) {
    const total = this.totalChunks || 0
    const count = this.downloadedCount
    const progress = total > 0 ? (count / total) * 100 : 0

    this.callback({
      type: 'progress',
      progress,
      count,
      total: this.totalChunks,
      ...extraData
    })
  }

  isValidChunk (event) {
    const cTag = event.tags.find(t => t[0] === 'c' && t[1].startsWith(this.fileRootHash + ':'))
    if (!cTag || cTag.length < 3) return false

    const parts = cTag[1].split(':')
    const index = parseInt(parts[1])
    if (isNaN(index) || index < 0 || index >= this.maxTotalChunks) return false

    const total = parseInt(cTag[2])
    if (isNaN(total) || total <= 0 || total > this.maxTotalChunks) return false

    if (this.totalChunks !== null && this.totalChunks !== total) return false

    return {
      index,
      total
    }
  }

  maybeFinish () {
    if ((this.missingIndexes.size > 0 && this.activeBatches > 0) || this.isRunning === false) return

    this.finish()
  }

  finish () {
    try {
      this.isRunning = false
      if (this.missingIndexes.size > 0) {
        const missing = this.totalChunks !== null ? Array.from(this.missingIndexes) : [0]
        if (this.debug) {
          const filter = {
            kinds: [34600],
            authors: [...new Set(Object.values(this.pubkeysByRelay).flat())],
            '#c': missing.map(i => `${this.fileRootHash}:${i}`),
            limit: missing.length
          }
          console.log('Check missing chunks with filter', filter)
        }
        this.reportProgress({ error: new Error('Missing file chunks'), chunkIndexes: missing })
      } else if (this.activeBatches > 0) {
        this.shouldGracefullyAbortRemainingBatches = true
      }
    } catch (err) {
      if (this.debug) console.error('Error during finish:', err)
    } finally {
      if (this.debug) console.log('Resolving run promise...')
      if (this.shouldGracefullyAbortRemainingBatches) this.onFailureAbortController.abort()
      this.resolveRun()
    }
  }
}
