import NMMR from 'nmmr'
import { relayPool as nostrRelays } from 'libp2r2p/relay'
import { parseIrfsChunkEvent } from '#services/irfs-chunk.js'
import { APP_FILE_CHUNK_BYTES } from '#constants/app-file.js'
import { warnAssetSizeMismatch } from '#helpers/asset-size.js'

const MAX_RANGE_LENGTH = 4096
const MIN_RANGE_LENGTH = 256
const MAX_RELAY_BATCHES = 3
const MAX_MISSING_SAMPLE = 100

// Untried indexes have not been selected by any relay yet. In-flight indexes
// are ordered by how many relays are already trying them. Positional stepping
// spreads the sorted missing indexes among relays without assigning each relay
// a permanently fixed chunk-index modulo.
export function getBatchIndexes ({ batchSize, untriedIndexes, orderedInFlightIndexes, step, offset }) {
  const selectedIndexes = []
  const groups = [untriedIndexes, orderedInFlightIndexes].filter(group => group.length)
  for (const availableIndexes of groups) {
    const wasUntried = availableIndexes === untriedIndexes
    let currentOffset = wasUntried ? offset : 0
    const effectiveStep = wasUntried ? step : 1
    const offsetLimit = currentOffset + effectiveStep
    while (selectedIndexes.length < batchSize && currentOffset < offsetLimit) {
      for (let index = currentOffset; index < availableIndexes.length; index += effectiveStep) {
        selectedIndexes.push({ idx: availableIndexes[index], wasUntried })
        if (selectedIndexes.length >= batchSize) break
      }
      if (selectedIndexes.length < batchSize) {
        const start = currentOffset % effectiveStep
        for (let index = start; index < currentOffset; index += effectiveStep) {
          selectedIndexes.push({ idx: availableIndexes[index], wasUntried })
          if (selectedIndexes.length >= batchSize) break
        }
      }
      currentOffset++
    }
    if (selectedIndexes.length >= batchSize) break
  }
  return selectedIndexes
}

function abortError () {
  return new Error('Aborted')
}

function assertSafeIndex (value, name = 'index') {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return value
}

function canonicalTotal (value) {
  if (value == null) return null
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('totalChunks must be a positive safe integer')
  return value
}

function canonicalPositiveInteger (value, name, fallback) {
  value ??= fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
  return value
}

// Returns the exact product until cap is reached, without ever overflowing a
// safe integer. The downloader only needs capped products for window sizing.
function cappedProduct (values, cap) {
  let product = 1
  for (const value of values) {
    if (product > Math.floor(cap / value)) return cap
    product *= value
  }
  return product
}

function combineSignals (...signals) {
  signals = signals.filter(Boolean)
  if (signals.length === 0) return null
  if (signals.length === 1) return signals[0]
  return AbortSignal.any(signals)
}

function indexesInRange (start, end) {
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
}

class RelayBatchLimiter {
  constructor (limit = MAX_RELAY_BATCHES) {
    this.limit = limit
    this.states = new Map()
  }

  schedule (url, workerId, task, { signal, onStart } = {}) {
    if (signal?.aborted) return Promise.reject(abortError())
    const state = this.#getState(url)
    if (state.queuedWorkers.has(workerId)) {
      return Promise.reject(new Error('A worker already has a pending batch for this relay'))
    }

    const deferred = Promise.withResolvers()
    const item = { deferred, onStart, signal, started: false, task, workerId }
    const onAbort = () => {
      if (item.started) return
      const index = state.queue.indexOf(item)
      if (index >= 0) state.queue.splice(index, 1)
      state.queuedWorkers.delete(workerId)
      deferred.reject(abortError())
      this.#drain(state)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    state.queue.push(item)
    state.queuedWorkers.add(workerId)
    this.#drain(state)
    return deferred.promise.finally(() => signal?.removeEventListener('abort', onAbort))
  }

  #getState (url) {
    let state = this.states.get(url)
    if (!state) {
      state = { active: 0, queue: [], queuedWorkers: new Set() }
      this.states.set(url, state)
    }
    return state
  }

  #drain (state) {
    while (state.active < this.limit && state.queue.length) {
      const item = state.queue.shift()
      state.queuedWorkers.delete(item.workerId)
      if (item.signal?.aborted) {
        item.deferred.reject(abortError())
        continue
      }

      item.started = true
      state.active++
      item.onStart?.()
      Promise.resolve()
        .then(item.task)
        .then(item.deferred.resolve, item.deferred.reject)
        .finally(() => {
          state.active--
          this.#drain(state)
        })
    }
  }
}

/**
 * Downloads one bounded, contiguous chunk range. Its arrays, Sets and relay
 * history can therefore never grow with the full blob size. Scheduling inside
 * the range intentionally follows the original positional round-robin logic.
 */
export class FileRangeDownloader {
  constructor (fileRootHash, pubkeysByRelay, callback, options = {}) {
    if (!/^[0-9a-f]{64}$/.test(fileRootHash)) throw new Error('Invalid MMR root hash')
    const urls = Object.keys(pubkeysByRelay)
    if (!urls.length) throw new Error('At least one relay is required')

    const startIndex = assertSafeIndex(options.startIndex ?? 0, 'startIndex')
    const endIndex = assertSafeIndex(options.endIndex, 'endIndex')
    const maxEndIndex = assertSafeIndex(options.maxEndIndex ?? endIndex, 'maxEndIndex')
    if (endIndex < startIndex || maxEndIndex < endIndex) throw new Error('Invalid chunk range')
    if ((maxEndIndex - startIndex + 1) > MAX_RANGE_LENGTH) throw new Error('Chunk range is too large')

    const totalChunks = canonicalTotal(options.totalChunks)
    if (totalChunks !== null && endIndex >= totalChunks) throw new Error('Chunk range exceeds totalChunks')
    const batchSize = canonicalPositiveInteger(options.batchSize, 'batchSize', 20)
    const cachedIndexes = new Set(options.cachedChunkIndexes || [])
    if (cachedIndexes.size > (endIndex - startIndex + 1)) throw new Error('Too many cached chunk indexes')
    for (const index of cachedIndexes) {
      assertSafeIndex(index, 'cached chunk index')
      if (index < startIndex || index > endIndex) throw new Error('Cached chunk index is outside its requested range')
    }

    const relayStates = new Map()
    urls.forEach((url, offset) => relayStates.set(url, {
      fallbackTriedIndexes: new Set(),
      offset,
      pendingBatch: false,
      scheduledBatches: 0,
      triedIndexes: new Set(),
      url
    }))

    this.abortController = new AbortController()
    Object.assign(this, {
      abortSignal: combineSignals(options.signal, this.abortController.signal),
      batchLimiter: options.batchLimiter || new RelayBatchLimiter(),
      batchSize,
      callback,
      coveredIndexes: cachedIndexes,
      debug: options.debug ?? false,
      fileRootHash,
      fallbackIndexes: new Set(),
      fallbackToAnyAuthor: options.fallbackToAnyAuthor === true,
      hasAuthorFilter: urls.some(url => Array.isArray(pubkeysByRelay[url]) && pubkeysByRelay[url].length > 0),
      inFlightIndexCounters: new Map(),
      isRunning: false,
      maxEndIndex,
      missingIndexes: new Set(),
      onCoverage: options.onCoverage || (() => {}),
      onTotalChunks: options.onTotalChunks || (total => total),
      pubkeysByRelay,
      rangeEnd: endIndex,
      rangeStart: startIndex,
      relayStates,
      reportedMissingIndexes: new Set(),
      scheduledBatchCount: 0,
      size: Number.isSafeInteger(options.size) && options.size >= 0 ? options.size : null,
      totalChunks,
      workerId: Symbol('file-range-downloader')
    })
    this.#rebuildMissingIndexes()
  }

  get coveredCount () {
    return this.coveredIndexes.size
  }

  get rangeLength () {
    return this.rangeEnd - this.rangeStart + 1
  }

  get coverageThreshold () {
    return Math.ceil(this.rangeLength * 0.3)
  }

  get materializedIndexCount () {
    return this.rangeLength
  }

  run () {
    if (this.runPromise) return this.runPromise
    this.isRunning = true
    ;({ promise: this.runPromise, resolve: this.resolveRun } = Promise.withResolvers())
    if (this.abortSignal?.aborted) {
      this.abort()
      return this.runPromise
    }
    this.abortSignal?.addEventListener('abort', () => this.abort(), { once: true })
    this.#notifyCoverage()
    this.#scheduleRelays()
    this.#maybeFinish()
    return this.runPromise
  }

  setTotalChunks (totalChunks) {
    totalChunks = canonicalTotal(totalChunks)
    if (this.totalChunks !== null && this.totalChunks !== totalChunks) throw new Error('Chunk totals disagree')
    if (this.totalChunks !== null) return
    if (totalChunks <= this.rangeStart) throw new Error('Discovered total does not contain this range')

    this.totalChunks = totalChunks
    const nextEnd = Math.min(this.maxEndIndex, totalChunks - 1)
    for (const index of this.coveredIndexes) {
      if (index > nextEnd) this.coveredIndexes.delete(index)
    }
    this.rangeEnd = nextEnd
    this.#rebuildMissingIndexes()
    this.#notifyCoverage()
    this.#scheduleRelays()
  }

  abort () {
    if (!this.isRunning) return
    this.isRunning = false
    this.abortController.abort()
    this.resolveRun?.({ aborted: true })
  }

  #rebuildMissingIndexes () {
    this.missingIndexes = new Set(
      indexesInRange(this.rangeStart, this.rangeEnd)
        .filter(index => !this.coveredIndexes.has(index))
    )
  }

  #getUntriedIndexes (relayState, fallback) {
    const triedIndexes = fallback ? relayState.fallbackTriedIndexes : relayState.triedIndexes
    return [...this.missingIndexes]
      .filter(index => this.fallbackIndexes.has(index) === fallback)
      .filter(index => !triedIndexes.has(index) && !this.inFlightIndexCounters.has(index))
      .sort((a, b) => a - b)
  }

  #getAvailableInFlightIndexes (relayState, fallback) {
    const triedIndexes = fallback ? relayState.fallbackTriedIndexes : relayState.triedIndexes
    return [...this.inFlightIndexCounters]
      .filter(([index]) => this.missingIndexes.has(index) && this.fallbackIndexes.has(index) === fallback)
      .filter(([index]) => !triedIndexes.has(index))
      .sort((a, b) => a[1] - b[1] || a[0] - b[0])
      .map(([index]) => index)
  }

  #selectBatch (relayState) {
    for (const fallback of [false, true]) {
      const selected = getBatchIndexes({
        batchSize: this.batchSize,
        offset: relayState.offset,
        orderedInFlightIndexes: this.#getAvailableInFlightIndexes(relayState, fallback),
        step: this.relayStates.size,
        untriedIndexes: this.#getUntriedIndexes(relayState, fallback)
      })
      if (selected.length) return { fallback, selected }
    }
    return { fallback: false, selected: [] }
  }

  #requestFromRelay (relayState) {
    if (!this.isRunning || relayState.pendingBatch || relayState.scheduledBatches >= MAX_RELAY_BATCHES) return false
    const { fallback, selected } = this.#selectBatch(relayState)
    if (!selected.length) return false

    const indexes = selected.map(item => item.idx)
    const triedIndexes = fallback ? relayState.fallbackTriedIndexes : relayState.triedIndexes
    for (const { idx, wasUntried } of selected) {
      triedIndexes.add(idx)
      const current = this.inFlightIndexCounters.get(idx) || 0
      this.inFlightIndexCounters.set(idx, wasUntried ? 1 : current + 1)
    }

    relayState.pendingBatch = true
    relayState.scheduledBatches++
    this.scheduledBatchCount++
    let started = false
    this.batchLimiter.schedule(relayState.url, this.workerId, async () => {
      if (!this.isRunning) throw abortError()
      await this.#downloadBatch(relayState, indexes, { fallback })
    }, {
      signal: this.abortSignal,
      onStart: () => {
        started = true
        relayState.pendingBatch = false
      }
    }).catch(error => {
      if (error.message !== 'Aborted' && this.debug) console.error('IRFS batch error', error)
    }).finally(() => {
      if (!started) relayState.pendingBatch = false
      relayState.scheduledBatches--
      this.scheduledBatchCount--
      for (const index of indexes) {
        if (!this.missingIndexes.has(index)) continue
        const count = this.inFlightIndexCounters.get(index) || 0
        if (count > 1) this.inFlightIndexCounters.set(index, count - 1)
        else this.inFlightIndexCounters.delete(index)
      }
      if (!this.isRunning) return
      this.#checkExhaustedIndexes(indexes)
      this.#scheduleRelays()
      this.#maybeFinish()
    })
    return true
  }

  #scheduleRelays () {
    if (!this.isRunning || this.missingIndexes.size === 0) return
    for (const relayState of this.relayStates.values()) this.#requestFromRelay(relayState)
  }

  async #downloadBatch (relayState, indexes, { fallback }) {
    const requested = new Set(indexes)
    const filter = {
      kinds: [34601],
      '#d': indexes.map(index => NMMR.deriveChunkId(this.fileRootHash, index)),
      limit: indexes.length
    }
    const authors = this.pubkeysByRelay[relayState.url]
    if (!fallback && Array.isArray(authors) && authors.length > 0) filter.authors = authors
    const generator = nostrRelays.getEventsGenerator(filter, [relayState.url], { signal: this.abortSignal })
    let rawReceivedCount = 0
    let halfBatchTriggered = false
    for await (const { event, type } of generator) {
      if (!this.isRunning) break
      if (type !== 'event' || !event) continue
      if (++rawReceivedCount > indexes.length * 4) break

      if (!halfBatchTriggered && rawReceivedCount >= Math.ceil(indexes.length / 2)) {
        halfBatchTriggered = true
        this.#requestFromRelay(relayState)
      }

      let metadata
      try {
        metadata = parseIrfsChunkEvent(event, { root: this.fileRootHash })
        if (!requested.has(metadata.index)) continue
        if (this.totalChunks === null) {
          const acceptedTotal = this.onTotalChunks(metadata.total)
          if (acceptedTotal !== metadata.total) throw new Error('Chunk totals disagree')
          this.setTotalChunks(acceptedTotal)
        } else if (metadata.total !== this.totalChunks) {
          continue
        }
      } catch (_) {
        continue
      }
      if (!this.isRunning || !this.missingIndexes.has(metadata.index)) continue

      if (metadata.index === metadata.total - 1) {
        const actualSize = ((metadata.total - 1) * APP_FILE_CHUNK_BYTES) + metadata.contentBytes.length
        if (Number.isSafeInteger(actualSize)) {
          warnAssetSizeMismatch({
            service: 'irfs',
            root: this.fileRootHash,
            advertisedSize: this.size,
            actualSize
          })
        }
      }

      this.missingIndexes.delete(metadata.index)
      this.coveredIndexes.add(metadata.index)
      this.inFlightIndexCounters.delete(metadata.index)
      this.callback({ chunkIndex: metadata.index, event, relay: relayState.url, authorFallback: fallback })
      this.#notifyCoverage()
    }
  }

  #notifyCoverage () {
    this.onCoverage({
      covered: this.coveredCount,
      length: this.rangeLength,
      threshold: this.coverageThreshold
    })
  }

  #checkExhaustedIndexes (indexes) {
    if (!this.isRunning) return
    for (const index of new Set(indexes)) {
      if (!this.missingIndexes.has(index) || this.reportedMissingIndexes.has(index)) continue
      if (this.totalChunks === null && index > 0) continue
      if ((this.inFlightIndexCounters.get(index) || 0) > 0) continue
      const fallback = this.fallbackIndexes.has(index)
      if ([...this.relayStates.values()].some(state =>
        !(fallback ? state.fallbackTriedIndexes : state.triedIndexes).has(index)
      )) continue

      if (!fallback && this.fallbackToAnyAuthor && this.hasAuthorFilter) {
        this.fallbackIndexes.add(index)
        continue
      }

      this.reportedMissingIndexes.add(index)
      this.callback({ error: new Error('Missing file chunk'), chunkIndex: index })
      if (!this.isRunning) return
    }
  }

  #maybeFinish () {
    if (!this.isRunning || this.scheduledBatchCount > 0) return
    if (this.missingIndexes.size > 0) {
      this.#scheduleRelays()
      if (this.scheduledBatchCount > 0) return
      this.#checkExhaustedIndexes(this.missingIndexes)
    }
    if (!this.isRunning) return
    this.isRunning = false
    this.resolveRun({
      missingCount: this.reportedMissingIndexes.size,
      missingIndexes: [...this.reportedMissingIndexes].slice(0, MAX_MISSING_SAMPLE)
    })
  }
}

/**
 * Orchestrates at most two bounded FileRangeDownloader instances. Completed
 * ranges are discarded, so memory is bounded by the active windows rather than
 * by the authenticated total number of chunks.
 */
export default class FileDownloader {
  constructor (fileRootHash, pubkeysByRelay, callback, options = {}) {
    if (!/^[0-9a-f]{64}$/.test(fileRootHash)) throw new Error('Invalid MMR root hash')
    const urls = Object.keys(pubkeysByRelay)
    if (!urls.length) throw new Error('At least one relay is required')

    const totalChunks = canonicalTotal(options.totalChunks)
    const requestedStart = assertSafeIndex(options.startIndex ?? 0, 'startIndex')
    const requestedEnd = options.endIndex == null
      ? null
      : assertSafeIndex(options.endIndex, 'endIndex')
    if (requestedEnd !== null && requestedEnd < requestedStart) throw new Error('Invalid requested chunk interval')
    if (totalChunks === null && requestedStart !== 0) {
      throw new Error('A non-zero startIndex requires totalChunks')
    }
    if (totalChunks !== null && requestedStart >= totalChunks) throw new Error('startIndex exceeds totalChunks')
    if (totalChunks !== null && requestedEnd !== null && requestedEnd >= totalChunks) {
      throw new Error('endIndex exceeds totalChunks')
    }
    const downloadEnd = totalChunks === null
      ? null
      : Math.min(requestedEnd ?? (totalChunks - 1), totalChunks - 1)
    const targetLength = downloadEnd === null ? null : downloadEnd - requestedStart + 1
    const batchSize = canonicalPositiveInteger(options.batchSize, 'batchSize', 20)
    const downloadedCount = options.downloadedCount ?? 0
    assertSafeIndex(downloadedCount, 'downloadedCount')
    if (targetLength !== null && downloadedCount > targetLength) throw new Error('downloadedCount exceeds requested interval')
    if (downloadedCount > 0 && (totalChunks === null || typeof options.loadDownloadedChunkIndexes !== 'function')) {
      throw new Error('downloadedCount requires totalChunks and loadDownloadedChunkIndexes')
    }

    const windowSize = Math.min(
      MAX_RANGE_LENGTH,
      Math.max(MIN_RANGE_LENGTH, cappedProduct([batchSize, urls.length, 4], MAX_RANGE_LENGTH))
    )
    const discoveryLength = cappedProduct([batchSize, urls.length], windowSize)
    const abortOnFailure = options.abortOnFailure ?? true

    this.abortController = new AbortController()
    Object.assign(this, {
      FileRangeDownloaderClass: options._FileRangeDownloader || FileRangeDownloader,
      abortOnFailure,
      abortSignal: combineSignals(options.signal, this.abortController.signal),
      activeRanges: new Map(),
      batchLimiter: new RelayBatchLimiter(),
      batchSize,
      callback,
      debug: options.debug ?? false,
      discoveryLength,
      downloadedCount,
      fileRootHash,
      fallbackToAnyAuthor: options.fallbackToAnyAuthor === true,
      hasStartedFirstRange: false,
      isRunning: false,
      loadDownloadedChunkIndexes: options.loadDownloadedChunkIndexes || (async () => []),
      loadedCachedCount: 0,
      missingCount: 0,
      missingSample: [],
      nextRangeStart: requestedStart,
      pubkeysByRelay,
      requestedEnd,
      requestedStart,
      size: Number.isSafeInteger(options.size) && options.size >= 0 ? options.size : null,
      totalChunks,
      downloadEnd,
      targetLength,
      windowSize
    })
  }

  run () {
    if (this.runPromise) return this.runPromise
    this.isRunning = true
    ;({ promise: this.runPromise, resolve: this.resolveRun } = Promise.withResolvers())

    if (this.abortSignal?.aborted) {
      this.#finish()
      return this.runPromise
    }
    this.abortSignal?.addEventListener('abort', () => {
      for (const slot of this.activeRanges.values()) slot.worker?.abort?.()
      this.#finish({ reportMissingSummary: false })
    }, { once: true })

    if (this.totalChunks !== null && this.downloadedCount > 0) this.#reportProgress()
    if (this.targetLength !== null && this.downloadedCount === this.targetLength) {
      this.#finish()
      return this.runPromise
    }

    this.#startNextRange()
    return this.runPromise
  }

  abort () {
    if (!this.isRunning) return
    this.abortController.abort()
    for (const slot of this.activeRanges.values()) slot.worker?.abort?.()
    this.#finish()
  }

  _isComplete () {
    return !this.isRunning
  }

  #setTotalChunks (totalChunks) {
    totalChunks = canonicalTotal(totalChunks)
    if (this.totalChunks !== null && this.totalChunks !== totalChunks) throw new Error('Chunk totals disagree')
    if (this.requestedStart >= totalChunks) throw new Error('Requested interval exceeds discovered totalChunks')
    if (this.requestedEnd !== null && this.requestedEnd >= totalChunks) throw new Error('Requested interval exceeds discovered totalChunks')
    this.totalChunks = totalChunks
    this.downloadEnd = Math.min(this.requestedEnd ?? (totalChunks - 1), totalChunks - 1)
    this.targetLength = this.downloadEnd - this.requestedStart + 1
    if (this.downloadedCount > this.targetLength) throw new Error('downloadedCount exceeds requested interval')
    return totalChunks
  }

  #startNextRange () {
    if (!this.isRunning || this.activeRanges.size >= 2) return false

    let start
    let end
    let maxEnd
    if (this.totalChunks === null) {
      if (this.hasStartedFirstRange) return false
      start = 0
      maxEnd = this.windowSize - 1
      end = this.discoveryLength - 1
      this.nextRangeStart = this.windowSize
      this.hasStartedFirstRange = true
    } else {
      if (this.nextRangeStart > this.downloadEnd) return false
      start = this.nextRangeStart
      const length = Math.min(this.windowSize, this.downloadEnd - start + 1)
      end = start + length - 1
      maxEnd = end
      this.nextRangeStart = end + 1
      this.hasStartedFirstRange = true
    }

    const length = end - start + 1
    const slot = { covered: 0, end, length, maxEnd, start, threshold: Math.ceil(length * 0.3), worker: null }
    this.activeRanges.set(start, slot)
    this.#loadAndRunRange(slot)
    return true
  }

  async #loadAndRunRange (slot) {
    try {
      const cachedIndexes = await this.#loadCachedIndexes(slot.start, slot.end)
      if (!this.isRunning || !this.activeRanges.has(slot.start)) return

      const worker = new this.FileRangeDownloaderClass(
        this.fileRootHash,
        this.pubkeysByRelay,
        data => this.#handleWorkerReport(slot, data),
        {
          batchLimiter: this.batchLimiter,
          batchSize: this.batchSize,
          cachedChunkIndexes: cachedIndexes,
          debug: this.debug,
          endIndex: slot.end,
          fallbackToAnyAuthor: this.fallbackToAnyAuthor,
          maxEndIndex: slot.maxEnd,
          onCoverage: coverage => this.#handleCoverage(slot, coverage),
          onTotalChunks: total => this.#setTotalChunks(total),
          signal: this.abortSignal,
          size: this.size,
          startIndex: slot.start,
          totalChunks: this.totalChunks
        }
      )
      slot.worker = worker
      await worker.run()
      this.#handleRangeFinished(slot)
    } catch (error) {
      this.#fail(error)
    }
  }

  async #loadCachedIndexes (start, end) {
    const values = await this.loadDownloadedChunkIndexes({ start, end })
    if (!values || typeof values[Symbol.iterator] !== 'function') {
      throw new Error('loadDownloadedChunkIndexes must return an iterable')
    }

    const indexes = []
    const seen = new Set()
    for (const index of values) {
      assertSafeIndex(index, 'downloaded chunk index')
      if (index < start || index > end) throw new Error('Downloaded chunk index is outside its requested range')
      if (seen.has(index)) throw new Error('Duplicate downloaded chunk index')
      seen.add(index)
      indexes.push(index)
      if (indexes.length > (end - start + 1)) throw new Error('Too many downloaded chunk indexes')
    }
    this.loadedCachedCount += indexes.length
    if (this.loadedCachedCount > this.downloadedCount) {
      throw new Error('Loaded chunk indexes exceed downloadedCount')
    }
    return indexes
  }

  #handleCoverage (slot, { covered, length, threshold }) {
    if (!this.isRunning || !this.activeRanges.has(slot.start)) return
    slot.covered = covered
    slot.length = length
    slot.threshold = threshold ?? Math.ceil(length * 0.3)
    if (covered >= slot.threshold) this.#startNextRange()
  }

  #handleWorkerReport (slot, data) {
    if (!this.isRunning || !this.activeRanges.has(slot.start)) return
    if (data.event) {
      this.downloadedCount++
      if (this.targetLength !== null && this.downloadedCount > this.targetLength) {
        this.#fail(new Error('Downloaded chunk count exceeds requested interval'))
        return
      }
      this.#reportProgress(data)
      return
    }
    if (!data.error) return

    this.missingCount++
    if (this.missingSample.length < MAX_MISSING_SAMPLE) this.missingSample.push(data.chunkIndex)
    this.#reportProgress({
      ...data,
      chunkIndexes: [...this.missingSample],
      missingCount: this.missingCount
    })
    if (this.abortOnFailure) {
      this.abortController.abort()
      for (const activeSlot of this.activeRanges.values()) activeSlot.worker?.abort?.()
      this.#finish({ reportMissingSummary: false })
    }
  }

  #handleRangeFinished (slot) {
    if (!this.activeRanges.has(slot.start)) return
    this.activeRanges.delete(slot.start)
    if (!this.isRunning) return

    if (this.activeRanges.size === 0) this.#startNextRange()
    else {
      const remaining = this.activeRanges.values().next().value
      if (remaining.worker && remaining.covered >= remaining.threshold) this.#startNextRange()
    }

    if (this.activeRanges.size === 0 && (this.totalChunks === null || this.nextRangeStart > this.downloadEnd)) {
      this.#finish()
    }
  }

  #reportProgress (extraData = {}) {
    const total = this.totalChunks || 0
    this.callback({
      type: 'progress',
      progress: total ? (this.downloadedCount / total) * 100 : 0,
      count: this.downloadedCount,
      total: this.totalChunks,
      ...extraData
    })
  }

  #fail (error) {
    if (!this.isRunning) return
    this.#reportProgress({ error })
    this.abortController.abort()
    for (const slot of this.activeRanges.values()) slot.worker?.abort?.()
    this.#finish({ reportMissingSummary: false })
  }

  #finish ({ reportMissingSummary = true } = {}) {
    if (!this.isRunning) return
    this.isRunning = false
    this.activeRanges.clear()
    if (reportMissingSummary && !this.abortOnFailure && this.missingCount > 0) {
      this.#reportProgress({
        error: new Error('Missing file chunks'),
        chunkIndexes: [...this.missingSample],
        missingCount: this.missingCount
      })
    }
    this.resolveRun?.()
  }
}
