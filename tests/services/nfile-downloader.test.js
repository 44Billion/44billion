import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import NMMR from 'nmmr'
import { encode } from 'libp2r2p/base93'
import { nfileEncode } from 'libp2r2p/nip19'

import NFileDownloader, { parseSingleByteRange } from '#services/nfile-downloader/index.js'

async function localFixture () {
  const mmr = new NMMR()
  const first = new Uint8Array(51000).fill(1)
  const last = Uint8Array.of(2, 3, 4)
  await mmr.append(first)
  await mmr.append(last)
  const chunks = await Array.fromAsync(mmr.getChunks())
  const byIndex = new Map(chunks.map(chunk => [chunk.index, chunk]))
  return { byIndex, bytes: new Uint8Array([...first, ...last]), root: mmr.getRoot() }
}

async function relayFixture () {
  const fixture = await localFixture()
  const events = new Map([...fixture.byIndex].map(([index, chunk]) => [index, {
    kind: 34601,
    created_at: 1,
    pubkey: 'a'.repeat(64),
    tags: [
      ['d', NMMR.deriveChunkId(fixture.root, index)],
      ['mmr', String(index), String(chunk.total), encode(chunk.proof)]
    ],
    content: encode(chunk.contentBytes)
  }]))
  return { ...fixture, events }
}

function scriptedFileDownloader (scripts, calls) {
  return class {
    constructor (root, relays, callback, options) {
      this.abortCalled = false
      this.callback = callback
      this.script = scripts[calls.length]
      calls.push({ instance: this, options, relays, root })
    }

    async run () {
      await this.script?.(this)
    }

    emit (event) {
      if (!this.abortCalled) this.callback({ event })
    }

    abort () {
      this.abortCalled = true
      this.resolveAbort?.()
    }
  }
}

function localOptions (fixture, extra = {}) {
  return {
    fallbackRelays: [],
    timeoutMs: 5,
    _findAnyLocalChunk: async () => fixture.byIndex.values().next().value || null,
    _findLocalChunk: async (_root, index) => fixture.byIndex.get(index) || null,
    _subscribeChunkArrivals: () => () => {},
    ...extra
  }
}

async function collect (iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

describe('nfile HTTP download', () => {
  it('parses full, open, suffix and invalid byte ranges', () => {
    assert.deepEqual(parseSingleByteRange(null, 100), { start: 0, end: 99, partial: false })
    assert.deepEqual(parseSingleByteRange('bytes=10-', 100), { start: 10, end: 99, partial: true })
    assert.deepEqual(parseSingleByteRange('bytes=-7', 100), { start: 93, end: 99, partial: true })
    assert.equal(parseSingleByteRange('bytes=0-1,3-4', 100), null)
    assert.equal(parseSingleByteRange('bytes=100-', 100), null)
  })

  it('streams a complete local file without assembling a Blob', async () => {
    const fixture = await localFixture()
    const downloader = new NFileDownloader(nfileEncode({
      root: fixture.root,
      relays: [],
      mime: 'application/octet-stream',
      filename: "fi'xture.bin"
    }), localOptions(fixture))
    const response = await downloader.open({ method: 'GET', localOnly: true })

    assert.equal(response.status, 200)
    assert.equal(response.headers['content-length'], String(fixture.bytes.byteLength))
    assert.match(response.headers['content-disposition'], /fi%27xture\.bin/)
    assert.equal(response.headers['access-control-allow-origin'], '*')
    assert.equal(response.headers['accept-ranges'], 'bytes')
    assert.deepEqual(await collect(response.body), fixture.bytes)
  })

  it('returns the exact cross-chunk byte range and supports HEAD', async () => {
    const fixture = await localFixture()
    const rangeDownloader = new NFileDownloader({ root: fixture.root, relays: [] }, localOptions(fixture))
    const response = await rangeDownloader.open({
      method: 'GET',
      range: 'bytes=50998-51001',
      localOnly: true
    })
    assert.equal(response.status, 206)
    assert.equal(response.headers['content-range'], `bytes 50998-51001/${fixture.bytes.byteLength}`)
    assert.deepEqual(await collect(response.body), fixture.bytes.slice(50998, 51002))

    const headDownloader = new NFileDownloader({ root: fixture.root, relays: [] }, localOptions(fixture))
    const head = await headDownloader.open({ method: 'HEAD', localOnly: true })
    assert.equal(head.status, 200)
    assert.equal(head.body, null)
    head.close()
  })

  it('returns 416 for an invalid range and 404 after local-only inactivity', async () => {
    const fixture = await localFixture()
    const invalid = new NFileDownloader({ root: fixture.root, relays: [] }, localOptions(fixture))
    const invalidResponse = await invalid.open({ method: 'GET', range: 'bytes=999999-', localOnly: true })
    assert.equal(invalidResponse.status, 416)
    assert.equal(invalidResponse.headers['content-range'], `bytes */${fixture.bytes.byteLength}`)
    invalidResponse.close()

    const missingFixture = { byIndex: new Map(), root: fixture.root }
    let networkConstructions = 0
    class UnexpectedNetworkDownloader {
      constructor () { networkConstructions++ }
    }
    const missing = new NFileDownloader({ root: fixture.root, relays: [] }, localOptions(missingFixture, {
      fallbackRelays: ['wss://should-not-run.example'],
      _FileDownloader: UnexpectedNetworkDownloader,
      _getUserRelays: async () => { throw new Error('NIP-65 should not run') }
    }))
    const missingResponse = await missing.open({ method: 'GET', localOnly: true })
    assert.equal(missingResponse.status, 404)
    assert.equal(networkConstructions, 0)
    missingResponse.close()
  })

  it('combines author write relays with hints and caches network chunks best-effort', async () => {
    const fixture = await relayFixture()
    const calls = []
    const cached = []
    const FileDownloaderClass = scriptedFileDownloader([
      async downloader => downloader.emit(fixture.events.get(1)),
      async downloader => downloader.emit(fixture.events.get(0))
    ], calls)
    const author = 'b'.repeat(64)
    const downloader = new NFileDownloader({
      root: fixture.root,
      relays: ['wss://hint.example/'],
      author
    }, {
      _FileDownloader: FileDownloaderClass,
      _findAnyLocalChunk: async () => null,
      _findLocalChunk: async () => null,
      _getUserRelays: async authors => {
        assert.deepEqual(authors, [author])
        return { [author]: { write: ['wss://write.example', 'wss://hint.example'] } }
      },
      _subscribeChunkArrivals: () => () => {},
      cacheEvent: async event => {
        cached.push(event)
        throw new Error('vault locked')
      },
      timeoutMs: 5
    })
    const response = await downloader.open({ method: 'GET', range: 'bytes=0-3' })

    assert.equal(response.status, 206)
    assert.deepEqual(await collect(response.body), fixture.bytes.slice(0, 4))
    assert.equal(calls.length, 2)
    for (const call of calls) {
      assert.deepEqual(call.relays, {
        'wss://hint.example': [author],
        'wss://write.example': [author]
      })
      assert.equal(call.options.fallbackToAnyAuthor, true)
    }
    assert.deepEqual(cached, [fixture.events.get(1)])
  })

  it('queries both nfile hints and fallback relays without an author filter', async () => {
    const fixture = await relayFixture()
    const calls = []
    const FileDownloaderClass = scriptedFileDownloader([
      async downloader => downloader.emit(fixture.events.get(1))
    ], calls)
    const downloader = new NFileDownloader({
      root: fixture.root,
      relays: ['wss://hint.example']
    }, {
      fallbackRelays: ['wss://fallback.example'],
      _FileDownloader: FileDownloaderClass,
      _findAnyLocalChunk: async () => null,
      _findLocalChunk: async () => null,
      _subscribeChunkArrivals: () => () => {},
      timeoutMs: 5
    })
    const response = await downloader.open({ method: 'GET', range: 'bytes=51000-' })

    assert.equal(response.status, 206)
    assert.deepEqual(await collect(response.body), fixture.bytes.slice(51000))
    assert.deepEqual(calls[0].relays, {
      'wss://hint.example': undefined,
      'wss://fallback.example': undefined
    })
    assert.equal(calls[0].options.fallbackToAnyAuthor, false)
  })

  it('extends local waiting when a new same-root index arrives outside the requested range', async () => {
    const mmr = new NMMR()
    await mmr.append(Uint8Array.of(7, 8, 9))
    const [chunk] = await Array.fromAsync(mmr.getChunks())
    let arrival
    let available = null
    const timerOne = setTimeout(() => arrival({ index: 99, newRootIndex: true }), 80)
    const timerTwo = setTimeout(() => {
      available = chunk
      arrival({ index: 0, newRootIndex: true })
    }, 140)
    const downloader = new NFileDownloader({ root: mmr.getRoot(), relays: [] }, {
      fallbackRelays: [],
      timeoutMs: 100,
      _findAnyLocalChunk: async () => available,
      _findLocalChunk: async (_root, index) => index === 0 ? available : null,
      _subscribeChunkArrivals: (_root, callback) => {
        arrival = callback
        return () => {}
      }
    })

    const response = await downloader.open({ method: 'GET', localOnly: true })
    clearTimeout(timerOne)
    clearTimeout(timerTwo)
    assert.equal(response.status, 200)
    assert.deepEqual(await collect(response.body), chunk.contentBytes)
  })

  it('aborts active batches and arrival waits when closed', async () => {
    const fixture = await localFixture()
    const calls = []
    const FileDownloaderClass = scriptedFileDownloader([
      downloader => new Promise(resolve => { downloader.resolveAbort = resolve })
    ], calls)
    let unsubscribed = false
    const downloader = new NFileDownloader({ root: fixture.root, relays: ['wss://relay.example'] }, {
      _FileDownloader: FileDownloaderClass,
      _findAnyLocalChunk: async () => null,
      _findLocalChunk: async () => null,
      _subscribeChunkArrivals: () => () => { unsubscribed = true },
      timeoutMs: 1000
    })
    const opening = downloader.open({ method: 'GET' })
    while (calls.length === 0) await new Promise(resolve => setImmediate(resolve))
    downloader.close()

    assert.equal((await opening).status, 404)
    assert.equal(calls[0].instance.abortCalled, true)
    assert.equal(unsubscribed, true)
  })
})
