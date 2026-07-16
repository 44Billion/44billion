import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import NMMR from 'nmmr'
import { encode } from 'libp2r2p/base93'
import FileDownloader, { FileRangeDownloader, getBatchIndexes } from '#services/file-downloader/index.js'
import { relayPool as nostrRelays } from 'libp2r2p/relay'

const PUBKEY = 'a'.repeat(64)

async function createChunks (total = 5) {
  const mmr = new NMMR()
  for (let index = 0; index < total; index++) {
    const length = index === total - 1 ? 17 : 51000
    await mmr.append(new Uint8Array(length).fill(index + 1))
  }
  const root = mmr.getRoot()
  const events = []
  for await (const chunk of mmr.getChunks()) {
    events.push({
      kind: 34601,
      pubkey: PUBKEY,
      id: NMMR.deriveChunkId(root, chunk.index),
      tags: [
        ['d', NMMR.deriveChunkId(root, chunk.index)],
        ['mmr', String(chunk.index), String(chunk.total), encode(chunk.proof)]
      ],
      content: encode(chunk.contentBytes),
      created_at: 1
    })
  }
  return { events, root: mmr.getRoot(), size: ((total - 1) * 51000) + 17 }
}

describe('getBatchIndexes', () => {
  test('interleaves untried indexes by position', () => {
    const options = {
      batchSize: 3,
      untriedIndexes: [0, 1, 2, 3, 4, 5],
      orderedInFlightIndexes: [],
      step: 2
    }
    assert.deepEqual(getBatchIndexes({ ...options, offset: 0 }), [
      { idx: 0, wasUntried: true },
      { idx: 2, wasUntried: true },
      { idx: 4, wasUntried: true }
    ])
    assert.deepEqual(getBatchIndexes({ ...options, offset: 1 }), [
      { idx: 1, wasUntried: true },
      { idx: 3, wasUntried: true },
      { idx: 5, wasUntried: true }
    ])
  })

  test('uses contiguous ordered in-flight indexes after untried indexes', () => {
    assert.deepEqual(getBatchIndexes({
      batchSize: 4,
      untriedIndexes: [0, 1],
      orderedInFlightIndexes: [10, 11, 12],
      step: 1,
      offset: 0
    }), [
      { idx: 0, wasUntried: true },
      { idx: 1, wasUntried: true },
      { idx: 10, wasUntried: false },
      { idx: 11, wasUntried: false }
    ])
  })

  test('rewinds to fill a batch without dropping positional groups', () => {
    assert.deepEqual(getBatchIndexes({
      batchSize: 7,
      untriedIndexes: [0, 1, 2, 3, 4, 5, 6],
      orderedInFlightIndexes: [],
      step: 2,
      offset: 3
    }).map(item => item.idx), [3, 5, 1, 4, 6, 0, 2])
  })

  test('rewinds when the initial offset is greater than the list length', () => {
    assert.deepEqual(getBatchIndexes({
      batchSize: 7,
      untriedIndexes: [0, 1, 2, 3, 4, 5, 6],
      orderedInFlightIndexes: [],
      step: 8,
      offset: 4
    }).map(item => item.idx), [4, 5, 6, 0, 1, 2, 3])
  })

  test('preserves the caller-provided in-flight concurrency order', () => {
    assert.deepEqual(getBatchIndexes({
      batchSize: 3,
      untriedIndexes: [],
      orderedInFlightIndexes: [12, 10, 11],
      step: 5,
      offset: 3
    }).map(item => item.idx), [12, 10, 11])
  })
})

async function waitFor (predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for test state')
}

describe('FileRangeDownloader scheduler', () => {
  let generatorMock

  beforeEach(() => {
    generatorMock = mock.method(nostrRelays, 'getEventsGenerator', async function * () {})
  })

  afterEach(() => generatorMock.mock.restore())

  test('interleaves contiguous missing positions across two relays', async () => {
    const fixture = await createChunks(6)
    const indexByD = new Map(fixture.events.map((event, index) => [event.tags[0][1], index]))
    const firstRequest = new Map()
    const allRequests = new Map()
    generatorMock.mock.mockImplementation(async function * (filter, [relay]) {
      const indexes = filter['#d'].map(d => indexByD.get(d))
      if (!firstRequest.has(relay)) firstRequest.set(relay, indexes)
      allRequests.set(relay, [...(allRequests.get(relay) || []), ...indexes])
    })

    await new FileRangeDownloader(fixture.root, {
      'wss://first.test': [PUBKEY],
      'wss://second.test': [PUBKEY]
    }, () => {}, {
      batchSize: 3,
      endIndex: 5,
      startIndex: 0,
      totalChunks: 6
    }).run()

    assert.deepEqual(firstRequest.get('wss://first.test'), [0, 2, 4])
    assert.deepEqual(firstRequest.get('wss://second.test').toSorted((a, b) => a - b), [1, 3, 5])
    for (const indexes of allRequests.values()) assert.equal(new Set(indexes).size, indexes.length)
  })

  test('interleaves the positions of sparse missing indexes', async () => {
    const fixture = await createChunks(11)
    const indexByD = new Map(fixture.events.map((event, index) => [event.tags[0][1], index]))
    const firstRequest = new Map()
    generatorMock.mock.mockImplementation(async function * (filter, [relay]) {
      if (!firstRequest.has(relay)) firstRequest.set(relay, filter['#d'].map(d => indexByD.get(d)))
    })

    await new FileRangeDownloader(fixture.root, {
      'wss://first.test': [PUBKEY],
      'wss://second.test': [PUBKEY]
    }, () => {}, {
      batchSize: 3,
      cachedChunkIndexes: [1, 3, 5, 7, 9],
      endIndex: 10,
      startIndex: 0,
      totalChunks: 11
    }).run()

    assert.deepEqual(firstRequest.get('wss://first.test'), [0, 4, 8])
    assert.deepEqual(firstRequest.get('wss://second.test').toSorted((a, b) => a - b), [2, 6, 10])
  })

  test('materializes at most one 4096-index window even for a huge total', () => {
    const worker = new FileRangeDownloader('a'.repeat(64), { r: [PUBKEY] }, () => {}, {
      endIndex: 4095,
      startIndex: 0,
      totalChunks: Number.MAX_SAFE_INTEGER
    })
    assert.equal(worker.materializedIndexCount, 4096)
    assert.equal(worker.missingIndexes.size, 4096)
  })
})

describe('FileDownloader range orchestration', () => {
  class ControlledRangeDownloader {
    static instances = []

    constructor (_root, _relays, callback, options) {
      this.callback = callback
      this.options = options
      this.deferred = Promise.withResolvers()
      ControlledRangeDownloader.instances.push(this)
    }

    run () {
      this.options.onCoverage({
        covered: this.options.cachedChunkIndexes.length,
        length: this.options.endIndex - this.options.startIndex + 1
      })
      return this.deferred.promise
    }

    cover (covered) {
      this.options.onCoverage({
        covered,
        length: this.options.endIndex - this.options.startIndex + 1
      })
    }

    finish () {
      this.deferred.resolve({ missingCount: 0, missingIndexes: [] })
    }

    abort () {
      this.deferred.resolve({ aborted: true })
    }
  }

  beforeEach(() => { ControlledRangeDownloader.instances = [] })

  test('starts a second range at 30% and rotates without exceeding two workers', async () => {
    const downloader = new FileDownloader('a'.repeat(64), { 'wss://relay.test': [PUBKEY] }, () => {}, {
      _FileRangeDownloader: ControlledRangeDownloader,
      batchSize: 20,
      totalChunks: 700
    })
    const runPromise = downloader.run()
    await waitFor(() => ControlledRangeDownloader.instances.length === 1)
    const first = ControlledRangeDownloader.instances[0]
    assert.equal(first.options.startIndex, 0)
    assert.equal(first.options.endIndex, 255)

    first.cover(76)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ControlledRangeDownloader.instances.length, 1)
    first.cover(77)
    await waitFor(() => ControlledRangeDownloader.instances.length === 2)
    assert.equal(downloader.activeRanges.size, 2)

    first.finish()
    await waitFor(() => downloader.activeRanges.size === 1)
    assert.equal(ControlledRangeDownloader.instances.length, 2)
    ControlledRangeDownloader.instances[1].cover(77)
    await waitFor(() => ControlledRangeDownloader.instances.length === 3)
    assert.equal(downloader.activeRanges.size, 2)
    assert.equal(ControlledRangeDownloader.instances[2].options.startIndex, 512)
    assert.equal(ControlledRangeDownloader.instances[2].options.endIndex, 699)

    downloader.abort()
    await runPromise
  })

  test('counts cached chunks toward the 30% threshold and loads cache by window', async () => {
    const loadedRanges = []
    const downloader = new FileDownloader('b'.repeat(64), { 'wss://relay.test': [PUBKEY] }, () => {}, {
      _FileRangeDownloader: ControlledRangeDownloader,
      batchSize: 20,
      downloadedCount: 77,
      loadDownloadedChunkIndexes: async range => {
        loadedRanges.push(range)
        return range.start === 0 ? Array.from({ length: 77 }, (_, index) => index) : []
      },
      totalChunks: 600
    })
    const runPromise = downloader.run()
    await waitFor(() => ControlledRangeDownloader.instances.length === 2)

    assert.deepEqual(loadedRanges, [{ start: 0, end: 255 }, { start: 256, end: 511 }])
    assert.equal(downloader.activeRanges.size, 2)
    downloader.abort()
    await runPromise
  })

  test('materializes only two bounded ranges for a huge authenticated total', async () => {
    const relays = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`wss://relay-${index}.test`, [PUBKEY]]))
    const downloader = new FileDownloader('c'.repeat(64), relays, () => {}, {
      _FileRangeDownloader: ControlledRangeDownloader,
      batchSize: 1024,
      totalChunks: Number.MAX_SAFE_INTEGER
    })
    const runPromise = downloader.run()
    await waitFor(() => ControlledRangeDownloader.instances.length === 1)
    ControlledRangeDownloader.instances[0].cover(Math.ceil(4096 * 0.3))
    await waitFor(() => ControlledRangeDownloader.instances.length === 2)

    assert.equal(downloader.windowSize, 4096)
    assert.equal(downloader.activeRanges.size, 2)
    assert.ok(ControlledRangeDownloader.instances.every(worker =>
      (worker.options.maxEndIndex - worker.options.startIndex + 1) <= 4096
    ))
    downloader.abort()
    await runPromise
  })

  test('enforces the shared limit of three active batches per relay', async () => {
    let instanceCount = 0
    let active = 0
    let maxActive = 0
    class LimiterProbeRangeDownloader extends ControlledRangeDownloader {
      constructor (...args) {
        super(...args)
        this.instanceNumber = instanceCount++
      }

      async run () {
        const length = this.options.endIndex - this.options.startIndex + 1
        this.options.onCoverage({ covered: Math.ceil(length * 0.3), length })
        const workerId = Symbol('limiter-probe')
        const count = this.instanceNumber === 0 ? 4 : 1
        const batches = Array.from({ length: count }, () =>
          this.options.batchLimiter.schedule('wss://relay.test', workerId, async () => {
            active++
            maxActive = Math.max(maxActive, active)
            await new Promise(resolve => setTimeout(resolve, 2))
            active--
          }).catch(() => {})
        )
        await Promise.all(batches)
        return { missingCount: 0, missingIndexes: [] }
      }
    }

    const downloader = new FileDownloader('d'.repeat(64), { 'wss://relay.test': [PUBKEY] }, () => {}, {
      _FileRangeDownloader: LimiterProbeRangeDownloader,
      batchSize: 20,
      totalChunks: 300
    })
    await downloader.run()
    assert.equal(maxActive, 3)
  })

  test('requires a total and bounded loader when downloadedCount is non-zero', () => {
    assert.throws(() => new FileDownloader('e'.repeat(64), { r: [PUBKEY] }, () => {}, {
      downloadedCount: 1
    }), /requires totalChunks/)
    assert.throws(() => new FileDownloader('e'.repeat(64), { r: [PUBKEY] }, () => {}, {
      downloadedCount: 1,
      totalChunks: 2
    }), /loadDownloadedChunkIndexes/)
  })

  test('rejects duplicate or out-of-window indexes returned by the cache loader', async () => {
    for (const cachedIndexes of [[0, 0], [3]]) {
      const reports = []
      await new FileDownloader('f'.repeat(64), { r: [PUBKEY] }, report => reports.push(report), {
        downloadedCount: 1,
        loadDownloadedChunkIndexes: async () => cachedIndexes,
        totalChunks: 3
      }).run()
      assert.match(reports.at(-1).error.message, /Duplicate|outside its requested range/)
    }
  })

  test('does not start a range whose cache load finishes after cancellation', async () => {
    const secondLoad = Promise.withResolvers()
    const downloader = new FileDownloader('1'.repeat(64), { r: [PUBKEY] }, () => {}, {
      _FileRangeDownloader: ControlledRangeDownloader,
      batchSize: 20,
      loadDownloadedChunkIndexes: ({ start }) => start === 0 ? [] : secondLoad.promise,
      totalChunks: 600
    })
    const runPromise = downloader.run()
    await waitFor(() => ControlledRangeDownloader.instances.length === 1)
    ControlledRangeDownloader.instances[0].cover(77)
    await waitFor(() => downloader.activeRanges.size === 2)

    downloader.abort()
    secondLoad.resolve([])
    await runPromise
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ControlledRangeDownloader.instances.length, 1)
    assert.equal(downloader.activeRanges.size, 0)
  })
})

describe('FileDownloader IRFS v2', () => {
  let generatorMock

  beforeEach(() => {
    generatorMock = mock.method(nostrRelays, 'getEventsGenerator', async function * () {
      yield { type: 'eose' }
    })
  })

  afterEach(() => generatorMock.mock.restore())

  test('downloads and cryptographically validates every leaf of a non-perfect MMR', async () => {
    const fixture = await createChunks(5)
    const byD = new Map(fixture.events.map(event => [event.tags[0][1], event]))
    const filters = []
    generatorMock.mock.mockImplementation(async function * (filter) {
      filters.push(filter)
      for (const d of filter['#d']) {
        const event = byD.get(d)
        if (event) yield { type: 'event', event }
      }
      yield { type: 'eose' }
    })
    const reports = []
    const downloader = new FileDownloader(fixture.root, { 'wss://relay.test': [PUBKEY] }, report => reports.push(report), {
      totalChunks: 5,
      size: fixture.size,
      batchSize: 2
    })
    await downloader.run()

    assert.equal(reports.filter(report => report.event).length, 5)
    assert.equal(reports.at(-1).progress, 100)
    assert.ok(filters.every(filter => filter.kinds[0] === 34601 && !filter['#c']))
    assert.ok(filters.every(filter => filter['#d'].every(value => /^[0-9a-f]{64}$/.test(value))))
  })

  test('downloads across a full 256-chunk window and a smaller final range', async () => {
    const fixture = await createChunks(257)
    const byD = new Map(fixture.events.map(event => [event.tags[0][1], event]))
    generatorMock.mock.mockImplementation(async function * (filter) {
      for (const d of filter['#d']) {
        const event = byD.get(d)
        if (event) yield { type: 'event', event }
      }
    })
    const reports = []
    const downloader = new FileDownloader(fixture.root, { 'wss://relay.test': [PUBKEY] }, report => reports.push(report), {
      batchSize: 64,
      totalChunks: 257
    })
    await downloader.run()

    assert.equal(downloader.windowSize, 256)
    assert.equal(reports.filter(report => report.event).length, 257)
    assert.equal(reports.at(-1).progress, 100)
  })

  test('bootstraps a bounded speculative window and learns total from a non-zero chunk', async () => {
    const fixture = await createChunks(3)
    const filters = []
    generatorMock.mock.mockImplementation(async function * (filter) {
      filters.push(filter)
      const requested = new Set(filter['#d'])
      if (requested.has(fixture.events[1].tags[0][1])) yield { type: 'event', event: fixture.events[1] }
      for (const event of fixture.events) {
        if (event === fixture.events[1]) continue
        if (requested.has(event.tags[0][1])) yield { type: 'event', event }
      }
    })
    const reports = []
    const downloader = new FileDownloader(fixture.root, { 'wss://relay.test': [PUBKEY] }, report => reports.push(report), {
      batchSize: 2
    })
    await downloader.run()
    assert.deepEqual(filters[0]['#d'], fixture.events.slice(0, 2).map(event => event.tags[0][1]))
    assert.equal(downloader.totalChunks, 3)
    assert.equal(downloader.windowSize, 256)
    assert.equal(reports.at(-1).progress, 100)
  })

  test('does not report speculative indexes beyond the authenticated total as missing', async () => {
    const fixture = await createChunks(2)
    const reports = []
    generatorMock.mock.mockImplementation(async function * (filter) {
      for (const d of filter['#d']) {
        const event = fixture.events.find(candidate => candidate.tags[0][1] === d)
        if (event) yield { type: 'event', event }
      }
    })
    const downloader = new FileDownloader(
      fixture.root,
      { 'wss://relay.test': [PUBKEY] },
      report => reports.push(report),
      { batchSize: 5 }
    )

    await downloader.run()
    assert.equal(reports.some(report => report.error), false)
    assert.equal(reports.at(-1).progress, 100)
  })

  test('warns but completes when the manifest size hint is wrong', async () => {
    const fixture = await createChunks(2)
    const reports = []
    generatorMock.mock.mockImplementation(async function * (filter) {
      for (const d of filter['#d']) {
        const event = fixture.events.find(candidate => candidate.tags[0][1] === d)
        if (event) yield { type: 'event', event }
      }
    })
    const consoleWarn = mock.method(console, 'warn', () => {})
    await new FileDownloader(
      fixture.root,
      { 'wss://relay.test': [PUBKEY] },
      report => reports.push(report),
      { size: 1 }
    ).run()
    const warningCount = consoleWarn.mock.callCount()
    consoleWarn.mock.restore()

    assert.equal(warningCount, 1)
    assert.equal(reports.some(report => report.error), false)
    assert.equal(reports.at(-1).progress, 100)
  })

  test('ignores mutated events and reports one bounded missing-index sample', async () => {
    const fixture = await createChunks(2)
    const bad = structuredClone(fixture.events[0])
    bad.content = encode(Uint8Array.of(9))
    generatorMock.mock.mockImplementation(async function * () {
      yield { type: 'event', event: bad }
    })
    const reports = []
    await new FileDownloader(fixture.root, { 'wss://relay.test': [PUBKEY] }, report => reports.push(report), {
      totalChunks: 2,
      batchSize: 2
    }).run()
    const failure = reports.find(report => report.error)
    assert.equal(failure.error.message, 'Missing file chunk')
    assert.ok(failure.chunkIndexes.length <= 100)
  })

  test('resumes from sparse ranges and treats size as an informational hint', async () => {
    const fixture = await createChunks(3)
    const byD = new Map(fixture.events.map(event => [event.tags[0][1], event]))
    generatorMock.mock.mockImplementation(async function * (filter) {
      for (const d of filter['#d']) if (byD.has(d)) yield { type: 'event', event: byD.get(d) }
    })
    const reports = []
    const loadedRanges = []
    const downloader = new FileDownloader(fixture.root, { 'wss://relay.test': [PUBKEY] }, report => reports.push(report), {
      totalChunks: 3,
      downloadedCount: 2,
      loadDownloadedChunkIndexes: async range => {
        loadedRanges.push(range)
        return [0, 1]
      },
      size: fixture.size
    })
    await downloader.run()
    assert.equal(reports[0].count, 2)
    assert.equal(reports.at(-1).progress, 100)
    assert.deepEqual(loadedRanges, [{ start: 0, end: 2 }])
    assert.doesNotThrow(() => new FileDownloader(fixture.root, { r: [PUBKEY] }, () => {}, {
      totalChunks: 2,
      size: fixture.size
    }))
  })

  test('continues when one relay misses a chunk that another relay provides', async () => {
    const fixture = await createChunks(3)
    const reports = []
    generatorMock.mock.mockImplementation(async function * (filter, [relay]) {
      for (const d of filter['#d']) {
        const event = fixture.events.find(candidate => candidate.tags[0][1] === d)
        if (event && (relay === 'wss://second.test' || event !== fixture.events[0])) yield { type: 'event', event }
      }
    })

    await new FileDownloader(fixture.root, {
      'wss://first.test': [PUBKEY],
      'wss://second.test': [PUBKEY]
    }, report => reports.push(report), { batchSize: 2 }).run()

    assert.equal(reports.filter(report => report.event).length, 3)
    assert.equal(reports.at(-1).progress, 100)
    assert.equal(reports.some(report => report.error), false)
  })

  test('aborts only after every relay has missed the same known chunk', async () => {
    const fixture = await createChunks(3)
    const missingD = fixture.events[1].tags[0][1]
    const reports = []
    generatorMock.mock.mockImplementation(async function * (filter) {
      for (const d of filter['#d']) {
        if (d === missingD) continue
        const event = fixture.events.find(candidate => candidate.tags[0][1] === d)
        if (event) yield { type: 'event', event }
      }
    })

    await new FileDownloader(fixture.root, {
      'wss://first.test': [PUBKEY],
      'wss://second.test': [PUBKEY]
    }, report => reports.push(report), { batchSize: 2 }).run()

    const errors = reports.filter(report => report.error)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].chunkIndex, 1)
  })

  test('reports an exhausted chunk but continues when abortOnFailure is false', async () => {
    const fixture = await createChunks(3)
    const missingD = fixture.events[1].tags[0][1]
    const reports = []
    generatorMock.mock.mockImplementation(async function * (filter) {
      for (const d of filter['#d']) {
        if (d === missingD) continue
        const event = fixture.events.find(candidate => candidate.tags[0][1] === d)
        if (event) yield { type: 'event', event }
      }
    })

    await new FileDownloader(fixture.root, { 'wss://relay.test': [PUBKEY] }, report => reports.push(report), {
      abortOnFailure: false,
      batchSize: 1
    }).run()

    const missingReportIndex = reports.findIndex(report => report.chunkIndex === 1 && report.error)
    assert.ok(missingReportIndex >= 0)
    assert.ok(reports.some(report => report.chunkIndex === 2 && report.event))
    assert.equal(reports.at(-1).error.message, 'Missing file chunks')
  })
})
