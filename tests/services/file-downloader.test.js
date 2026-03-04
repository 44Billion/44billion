import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import FileDownloader, { getBatchIndexes } from '#services/file-downloader/index.js'
import nostrRelays from '#services/nostr-relays.js'

describe('getBatchIndexes', () => {
  test('should pick untried indexes using round-robin step/offset', () => {
    const untriedIndexes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    // Consumer 1: step 2, offset 0 -> 0, 2, 4, 6, 8
    const result1 = getBatchIndexes({
      batchSize: 3,
      untriedIndexes,
      orderedInFlightIndexes: [],
      step: 2,
      offset: 0
    })
    assert.deepEqual(result1, [
      { idx: 0, wasUntried: true },
      { idx: 2, wasUntried: true },
      { idx: 4, wasUntried: true }
    ])

    // Consumer 2: step 2, offset 1 -> 1, 3, 5, 7, 9
    const result2 = getBatchIndexes({
      batchSize: 3,
      untriedIndexes,
      orderedInFlightIndexes: [],
      step: 2,
      offset: 1
    })
    assert.deepEqual(result2, [
      { idx: 1, wasUntried: true },
      { idx: 3, wasUntried: true },
      { idx: 5, wasUntried: true }
    ])
  })

  test('should pick contiguous in-flight indexes regardless of consumer step/offset', () => {
    const orderedInFlightIndexes = [10, 11, 12, 13, 14, 15]
    // Even if consumer has step 5, offset 3, it should pick inflights contiguously: 10, 11, 12...
    const result = getBatchIndexes({
      batchSize: 3,
      untriedIndexes: [],
      orderedInFlightIndexes,
      step: 5,
      offset: 3
    })
    assert.deepEqual(result, [
      { idx: 10, wasUntried: false },
      { idx: 11, wasUntried: false },
      { idx: 12, wasUntried: false }
    ])
  })

  test('should fallback to in-flight indexes if untried are exhausted', () => {
    const untriedIndexes = [0, 1]
    const orderedInFlightIndexes = [10, 11, 12]
    // step 1, offset 0
    const result = getBatchIndexes({
      batchSize: 4,
      untriedIndexes,
      orderedInFlightIndexes,
      step: 1,
      offset: 0
    })
    assert.deepEqual(result, [
      { idx: 0, wasUntried: true },
      { idx: 1, wasUntried: true },
      { idx: 10, wasUntried: false },
      { idx: 11, wasUntried: false }
    ])
  })

  test('should initially skip untried indexes that do not match round-robin slot than eventually pick remaining then check in-flight', () => {
    const untriedIndexes = [0, 1, 2, 3]
    // step 2, offset 0 -> should match 0, 2. Should skip 1.
    // batchSize 4.
    // It should pick 0, 2 from untried.
    // Then fallback to in-flight?
    const result = getBatchIndexes({
      batchSize: 5,
      untriedIndexes,
      orderedInFlightIndexes: [10, 11],
      step: 2,
      offset: 0
    })
    // 0 (matches), 1 (skips but eventually picked because offset wraps), 2 (matches)
    // Actually our new implementation wraps around if untried exhausted.
    // 0 % 2 = 0.
    // 2 % 2 = 0.
    // 1 % 2 = 1.
    // So 0, 2, 1.
    // Then checks in-flight 10.
    assert.deepEqual(result, [
      { idx: 0, wasUntried: true },
      { idx: 2, wasUntried: true },
      { idx: 1, wasUntried: true },
      { idx: 3, wasUntried: true },
      { idx: 10, wasUntried: false }
    ])
  })

  test('should rewind after reaching array end if batch not full (offset: 3, step: 2)', () => {
    // offset: 3, step: 2, untried: [0, 1, 2, 3, 4, 5, 6], batchSize: 7
    // Expected trace:
    // It 1: start 3. Picks 3, 5. Rewinds (start 1). Picks 1. -> [3, 5, 1]
    // It 2: start 4. Picks 4, 6. Rewinds (start 0). Picks 0, 2. -> [3, 5, 1, 4, 6, 0, 2]
    const untriedIndexes = [0, 1, 2, 3, 4, 5, 6]
    const result = getBatchIndexes({
      batchSize: 7,
      untriedIndexes,
      orderedInFlightIndexes: [],
      step: 2,
      offset: 3
    })

    assert.deepEqual(result, [
      { idx: 3, wasUntried: true },
      { idx: 5, wasUntried: true },
      { idx: 1, wasUntried: true },

      { idx: 4, wasUntried: true },
      { idx: 6, wasUntried: true },
      { idx: 0, wasUntried: true },
      { idx: 2, wasUntried: true }
    ])
  })

  test('should handle offset greater than array length (offset: 4, step: 8)', () => {
    // offset: 4, step: 8, untried: [0, 1, 2, 3, 4, 5, 6], batchSize: 7
    // Expected trace:
    // It 1 (off 4): Picks 4. Rewind (start 4) no-op. -> [4]
    // It 2 (off 5): Picks 5. Rewind (start 5) no-op. -> [4, 5]
    // It 3 (off 6): Picks 6. Rewind (start 6) no-op. -> [4, 5, 6]
    // It 4 (off 7): 7>=7. Rewind (start 7) no-op. -> [4, 5, 6]
    // It 5 (off 8): 8>=7. Rewind (start 0): Picks 0. -> [4, 5, 6, 0]
    // ...
    // Final: 4, 5, 6, 0, 1, 2, 3
    const untriedIndexes = [0, 1, 2, 3, 4, 5, 6]
    const result = getBatchIndexes({
      batchSize: 7,
      untriedIndexes,
      orderedInFlightIndexes: [],
      step: 8,
      offset: 4
    })

    assert.deepEqual(result, [
      { idx: 4, wasUntried: true },
      { idx: 5, wasUntried: true },
      { idx: 6, wasUntried: true },
      { idx: 0, wasUntried: true },
      { idx: 1, wasUntried: true },
      { idx: 2, wasUntried: true },
      { idx: 3, wasUntried: true }
    ])
  })
})

function createChunkTracker (options = {}, callback) {
  const downloadedChunkIndexes = new Set(options.downloadedChunkIndexes || [])
  const track = (data) => {
    if (data.type === 'progress' && data.chunkIndex !== undefined && data.event !== undefined) {
      downloadedChunkIndexes.add(data.chunkIndex)
    }
    if (callback) callback(data)
  }
  return { downloadedChunkIndexes, track }
}

describe('FileDownloader', () => {
  let downloadGeneratorMock

  beforeEach(() => {
    // Just mock it. If it throws because already mocked, we catch it or use restoreAll if possible.
    // But safer to just re-implement if it persists?
    // Or check if it is already a mock?

    // Correct way: restore specifically if we have reference.
    if (downloadGeneratorMock?.mock?.restore) {
      downloadGeneratorMock.mock.restore()
    } else if (downloadGeneratorMock?.restore) {
      downloadGeneratorMock.restore()
    }

    downloadGeneratorMock = mock.method(nostrRelays, 'getEventsGenerator', async function * (_filter, _relays) {
      yield { type: 'eose' }
    })
  })

  afterEach(() => {
    if (downloadGeneratorMock?.mock?.restore) {
      downloadGeneratorMock.mock.restore()
    } else if (downloadGeneratorMock?.restore) {
      downloadGeneratorMock.restore()
    }
    downloadGeneratorMock = null
  })

  test('should initialize correctly', () => {
    const fd = new FileDownloader('hash', { 'ws://r1': ['pk1'] }, () => {}, { totalChunks: 100, batchSize: 40 })
    assert.equal(fd.fileRootHash, 'hash')
    assert.equal(fd.totalChunks, 100)
    assert.equal(fd.relayStates.size, 1)
  })

  test('should download chunks from single relay', async () => {
    const total = 50
    const hash = 'root1'

    downloadGeneratorMock.mock.mockImplementation(async function * (filter) {
      const indexes = filter['#c'].map(s => parseInt(s.split(':')[1]))
      for (const idx of indexes) {
        yield {
          type: 'event',
          event: {
            tags: [['c', `${hash}:${idx}`, `${total}`]]
          }
        }
      }
    })

    const callbackCalls = []
    const options = { totalChunks: total, batchSize: 40 }
    const { downloadedChunkIndexes, track } = createChunkTracker(options, (data) => {
      callbackCalls.push(data)
    })
    const fd = new FileDownloader(hash, { 'ws://r1': ['pk1'] }, track, options)

    await fd.run()

    assert.equal(downloadedChunkIndexes.size, 50)
    // No initial progress because downloadedChunkIndexes is empty
    assert.equal(callbackCalls.length, 50, `Expected 50 calls, got ${callbackCalls.length}`)
    assert.equal(callbackCalls[49].progress, 100)
  })

  test('should send initial progress if chunks already downloaded', async () => {
    const total = 50
    const hash = 'root1-resume'

    downloadGeneratorMock.mock.mockImplementation(async function * (_filter) {
      // yield { type: 'eose' } // there is no such message. it ends when internal promise resolves
    })

    const callbackCalls = []
    const options = { totalChunks: total, downloadedChunkIndexes: [0, 1], batchSize: 40 }
    const { track } = createChunkTracker(options, (data) => {
      callbackCalls.push(data)
    })
    const fd = new FileDownloader(hash, { 'ws://r1': ['pk1'] }, track, options)

    await fd.run()

    // Should verify initial progress was sent
    assert.ok(callbackCalls.length >= 1)
    assert.equal(callbackCalls[0].type, 'progress')
    assert.equal(callbackCalls[0].count, 2)
    assert.equal(callbackCalls[0].error, undefined)
  })

  test('should detect total chunks from c tag if unknown', async () => {
    const total = 10
    const hash = 'root2'

    downloadGeneratorMock.mock.mockImplementation(async function * (filter) {
      const indexes = filter['#c'].map(s => parseInt(s.split(':')[1]))
      for (const idx of indexes) {
        if (idx < total) {
          yield {
            type: 'event',
            event: {
              tags: [['c', `${hash}:${idx}`, `${total}`]]
            }
          }
        }
      }
    })

    const options = { batchSize: 40 }
    const { downloadedChunkIndexes, track } = createChunkTracker(options)
    const fd = new FileDownloader(hash, { 'ws://r1': ['pk1'] }, track, options)

    await fd.run()

    assert.equal(fd.totalChunks, 10)
    assert.equal(downloadedChunkIndexes.size, 10)
  })

  test('should trigger parallel batch when half batch is done', async () => {
    const total = 100
    const hash = 'root3'
    const relay = 'ws://r1'

    let concurrentCalls = 0
    let maxConcurrent = 0

    downloadGeneratorMock.mock.mockImplementation(async function * (filter) {
      concurrentCalls++
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls)

      const indexes = filter['#c'].map(s => parseInt(s.split(':')[1]))

      for (let i = 0; i < indexes.length; i++) {
        yield {
          type: 'event',
          event: {
            tags: [['c', `${hash}:${indexes[i]}`, `${total}`]]
          }
        }
        if (i >= 20 && i < 25) {
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      }

      concurrentCalls--
    })

    const options = { totalChunks: total, batchSize: 40 }
    const { downloadedChunkIndexes, track } = createChunkTracker(options)
    const fd = new FileDownloader(hash, { [relay]: ['pk1'] }, track, options)

    await fd.run()

    assert.equal(downloadedChunkIndexes.size, 100)
    assert.ok(maxConcurrent >= 2, `Expected maxConcurrent to be at least 2, got ${maxConcurrent}`)
  })

  test('should fallback if one relay fails', async () => {
    const total = 100
    const hash = 'root5'
    const relays = { 'ws://r1': ['p'], 'ws://r2': ['p'] }

    downloadGeneratorMock.mock.mockImplementation(async function * (filter, relayList) {
      const indexes = filter['#c'].map(s => parseInt(s.split(':')[1]))
      if (relayList[0] === 'ws://r2') {
        for (const idx of indexes) {
          yield { type: 'event', event: { tags: [['c', `${hash}:${idx}`, `${total}`]] } }
        }
      } else {
        // yield { type: 'eose' }
      }
    })

    const options = { totalChunks: total, batchSize: 40 }
    const { downloadedChunkIndexes, track } = createChunkTracker(options)
    const fd = new FileDownloader(hash, relays, track, options)
    await fd.run()
    assert.equal(downloadedChunkIndexes.size, 100)
  })

  test('single relay should batch contiguously', async () => {
    const total = 100
    const hash = 'root6'

    const requests = []
    downloadGeneratorMock.mock.mockImplementation(async function * (filter) {
      const indexes = filter['#c'].map(s => parseInt(s.split(':')[1]))
      requests.push(...indexes)
      for (const idx of indexes) {
        yield { type: 'event', event: { tags: [['c', `${hash}:${idx}`, `${total}`]] } }
      }
    })

    const options = { totalChunks: total, batchSize: 40 }
    const { track } = createChunkTracker(options)
    const fd = new FileDownloader(hash, { 'ws://r1': ['p'] }, track, options)
    await fd.run()

    const firstBatch = requests.slice(0, 40)
    assert.equal(firstBatch[0], 0)
    assert.equal(firstBatch[39], 39)
    const sorted = [...firstBatch].sort((a, b) => a - b)
    assert.deepEqual(firstBatch, sorted)
  })

  test('should ignore invalid chunks', async () => {
    const total = 5
    const hash = 'root7'

    downloadGeneratorMock.mock.mockImplementation(async function * (filter) {
      const indexes = filter['#c'].map(s => parseInt(s.split(':')[1]))
      for (const idx of indexes) {
        if (idx === 1) {
          yield { type: 'event', event: { tags: [['c', `${hash}:${idx}`, '999999']] } }
        } else if (idx === 2) {
          yield { type: 'event', event: { tags: [['c', `wrong:${idx}`, `${total}`]] } }
        } else if (idx === 3) {
          yield { type: 'event', event: { tags: [['c', `${hash}:${idx}`, 'bad']] } }
        } else {
          yield { type: 'event', event: { tags: [['c', `${hash}:${idx}`, `${total}`]] } }
        }
      }
    })

    let events = 0
    const options = { totalChunks: total, batchSize: 40, abortOnFailure: false }
    const { downloadedChunkIndexes, track } = createChunkTracker(options, (d) => {
      if (d.type === 'progress' && d.chunkIndex !== undefined && !d.error) events++
    })
    const fd = new FileDownloader(hash, { 'ws://r1': ['p'] }, track, options)
    await fd.run()

    assert.equal(downloadedChunkIndexes.size, 2)
    assert.ok(downloadedChunkIndexes.has(0))
    assert.ok(downloadedChunkIndexes.has(4))
    assert.equal(events, 2, 'Should strictly report progress for valid chunks only')
  })

  test('should interleave chunks among multiple relays and backfill', async () => {
    const total = 100
    const hash = 'root4'
    const relays = { 'ws://r1': ['p1'], 'ws://r2': ['p2'] }

    const relayRequests = { 'ws://r1': [], 'ws://r2': [] }

    downloadGeneratorMock.mock.mockImplementation(async function * (filter, relayList) {
      const relayUrl = relayList[0]
      const indexes = filter['#c'].map(s => parseInt(s.split(':')[1]))
      if (relayRequests[relayUrl]) relayRequests[relayUrl].push(...indexes)

      for (const idx of indexes) {
        yield {
          type: 'event',
          event: { tags: [['c', `${hash}:${idx}`, `${total}`]] }
        }
      }
    })

    const options = { totalChunks: total, batchSize: 40 }
    const { downloadedChunkIndexes, track } = createChunkTracker(options)
    const fd = new FileDownloader(hash, relays, track, options)
    await fd.run()

    const r1FirstBatch = relayRequests['ws://r1'].slice(0, 40)
    const r2FirstBatch = relayRequests['ws://r2'].slice(0, 40)

    const r1Evens = r1FirstBatch.filter(i => i % 2 === 0).length
    const r2Odds = r2FirstBatch.filter(i => i % 2 !== 0).length

    assert.ok(r1Evens >= 1, 'Relay 1 should have some even indexes')
    assert.ok(r2Odds >= 1, 'Relay 2 should have some odd indexes')

    assert.equal(downloadedChunkIndexes.size, 100)
  })

  test('should report error and abort if chunk cannot be downloaded from any relay', async () => {
    const total = 5
    const hash = 'root8'
    const relays = { 'ws://r1': ['p'], 'ws://r2': ['p'] }

    // Mock: fail to serve chunk 3 on all relays
    downloadGeneratorMock.mock.mockImplementation(async function * (filter, _relayList) {
      const indexes = filter['#c'].map(s => parseInt(s.split(':')[1]))

      for (const idx of indexes) {
        if (idx === 3) {
          // Both relays simulate failure/missing for chunk 3
          // Just don't yield it
          continue
        }

        // Add artificial delay to allow abort to process before everything finishes
        if (idx === 4) await new Promise(resolve => setTimeout(resolve, 10))

        yield {
          type: 'event',
          event: { tags: [['c', `${hash}:${idx}`, `${total}`]] }
        }
      }
    })

    const errors = []
    const options = { totalChunks: total, abortOnFailure: true, batchSize: 40 }
    const { downloadedChunkIndexes, track } = createChunkTracker(options, (d) => { if (d.error) errors.push(d) })
    const fd = new FileDownloader(
      hash,
      relays,
      track,
      options
    )

    await fd.run()

    // Should have reported error for chunk 3
    const hasMissingChunk3Error = errors.some(e =>
      // Could be 'Missing file chunk' and e.chunkIndex=3 but when that index was tried to be downloaded,
      // the totalChunks was not yet known, so it will just report at the end with plural 'Missing file chunks'
      // and chunkIndexes array.
      e.error && e.error.message === 'Missing file chunks' && e.chunkIndexes[0] === 3 && e.chunkIndexes.length === 1
    )
    assert.ok(hasMissingChunk3Error, 'Should report missing chunk 3 error')

    // Chunk 3 is missing
    assert.ok(!downloadedChunkIndexes.has(3))

    // Because we aborted, we might not have downloaded chunk 4 either (due to delay)
    // or maybe we did if it raced. But main point is run() finished, error reported.
    assert.equal(fd.isRunning, false)
  })

  test('should NOT report missing chunk if it is beyond the discovered totalChunks', async () => {
    // Scenario:
    // We don't know total chunks initially.
    // effectiveTotal defaults to maxTempTotal (BATCH_SIZE * 1 = 40).
    // We request batch 0..39.
    // We receive chunk 0 which says totalChunks = 5.
    // We receive chunks 0..4.
    // Chunks 5..39 are not received.
    // They should NOT be marked as missing because they are >= totalChunks.

    const actualTotal = 5
    const hash = 'root9-false-positive'
    const relays = { 'ws://r1': ['p'] }

    downloadGeneratorMock.mock.mockImplementation(async function * (filter, _relayList) {
      const indexes = filter['#c'].map(s => parseInt(s.split(':')[1]))
      for (const idx of indexes) {
        if (idx < actualTotal) {
          yield {
            type: 'event',
            event: { tags: [['c', `${hash}:${idx}`, `${actualTotal}`]] }
          }
        }
      }
    })

    const errors = []
    const options = { abortOnFailure: true, batchSize: 40 }
    const { downloadedChunkIndexes, track } = createChunkTracker(options, (d) => { if (d.error) errors.push(d) })
    const fd = new FileDownloader(
      hash,
      relays,
      track,
      // totalChunks not provided specifically to rely on maxTempTotal
      options
    )

    await fd.run()

    // Should NOT have reported error for chunk 5, 6, etc.
    if (errors.length > 0) {
      console.error('Unexpected errors:', errors)
    }
    assert.equal(errors.length, 0, 'Should not report errors for chunks outside total')
    assert.equal(fd.totalChunks, actualTotal)
    assert.equal(downloadedChunkIndexes.size, actualTotal)
  })

  test('should not report missing chunk error if totalChunks is unknown, unless index is 0', async () => {
    const hash = 'root-unknown'
    const relays = { 'ws://r1': ['p'] }

    // Simulate empty relay (file not found)
    downloadGeneratorMock.mock.mockImplementation(async function * (_filter, _relayList) {
      // yield { type: 'eose' }
    })

    const errors = []
    const options = { abortOnFailure: true, batchSize: 40 }
    const { downloadedChunkIndexes, track } = createChunkTracker(options, (d) => { if (d.error) errors.push(d) })
    const fd = new FileDownloader(
      hash,
      relays,
      track,
      options
    )

    await fd.run()
    assert.equal(errors[0].chunkIndex, 0, 'Should report missing chunk error for index 0 when no chunks are found and total is unknown')
    assert.equal(downloadedChunkIndexes.size, 0)
    assert.equal(fd.totalChunks, null)
  })
})

describe.skip('Integration (Real Network)', () => {
  const TIMEOUT = 60000

  test('should download from 44billion relay', { timeout: TIMEOUT }, async () => {
    const rootHash = '09a8fee6b54ace1e08d5dabaebeed4ed05a556f11656a10caab3ad4ebee0caf7'
    const relays = {
      'wss://relay.44billion.net': [
        '5a8bc85694d8fbb4f30208649c1c52509636d1e6fdb1f0f4c84a3f10f9383ec9'
      ]
    }

    const errors = []
    const { downloadedChunkIndexes, track } = createChunkTracker({}, (d) => { if (d.error) errors.push(d) })
    const fd = new FileDownloader(rootHash, relays, track, { batchSize: 10, totalChunks: null })

    await fd.run()
    await nostrRelays.disconnectAll()

    if (errors.length > 0) console.error('Unexpected errors:', errors)
    const missingChunkErrors = errors.filter(e =>
      e.error && (e.error.message === 'Missing file chunk' || e.error.message === 'Missing file chunks')
    )
    assert.equal(missingChunkErrors.length, 0, 'Should not report missing chunk errors')

    assert.ok(downloadedChunkIndexes.size > 0, 'No chunks downloaded')
    if (fd.totalChunks) {
      assert.equal(downloadedChunkIndexes.size, fd.totalChunks, 'Should download all chunks')
    } else console.warn('Total chunks unknown, cannot assert all chunks downloaded')
  })

  test('should download from multiple relays', { timeout: TIMEOUT }, async () => {
    const rootHash = '09a8fee6b54ace1e08d5dabaebeed4ed05a556f11656a10caab3ad4ebee0caf7'
    const relays = {
      'wss://relay.primal.net': [
        '5a8bc85694d8fbb4f30208649c1c52509636d1e6fdb1f0f4c84a3f10f9383ec9'
      ],
      'wss://nos.lol': [
        '5a8bc85694d8fbb4f30208649c1c52509636d1e6fdb1f0f4c84a3f10f9383ec9'
      ],
      'wss://relay.44billion.net': [
        '5a8bc85694d8fbb4f30208649c1c52509636d1e6fdb1f0f4c84a3f10f9383ec9'
      ]
    }

    const errors = []
    const previouslyDownloaded = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 16]
    const { downloadedChunkIndexes, track } = createChunkTracker({ downloadedChunkIndexes: previouslyDownloaded }, (d) => { if (d.error) errors.push(d) })
    const fd = new FileDownloader(rootHash, relays, track, {
      batchSize: 10,
      totalChunks: 17,
      downloadedChunkIndexes: previouslyDownloaded
    })

    await fd.run()
    await nostrRelays.disconnectAll()

    if (errors.length > 0) console.error('Unexpected errors:', errors)
    const missingChunkErrors = errors.filter(e =>
      e.error && (e.error.message === 'Missing file chunk' || e.error.message === 'Missing file chunks')
    )
    assert.equal(missingChunkErrors.length, 0, 'Should not report missing chunk errors')

    assert.ok(downloadedChunkIndexes.size > 0, 'No chunks downloaded')
    if (fd.totalChunks) {
      assert.equal(downloadedChunkIndexes.size, fd.totalChunks, 'Should download all chunks')
    } else console.warn('Total chunks unknown, cannot assert all chunks downloaded')
  })
})
