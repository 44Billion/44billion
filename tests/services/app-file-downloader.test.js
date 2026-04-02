import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import AppFileDownloader from '../../src/services/app-file-downloader/index.js'
import { appIdToAddressObj } from '../../src/helpers/app.js'

describe('AppFileDownloader', () => {
  // valid appId with 43 chars for pubkey (base62)
  const appId = 'a0000000000000000000000000000000000000000000test'
  const writeRelays = ['wss://relay1.com', 'wss://relay2.com', 'wss://relay3.com']

  describe('getSiteManifestEvents', () => {
    it('should fetch site manifest events and return them grouped by appId', async () => {
      const mockEvent = { id: 'manifest1', kind: 35128, tags: [['d', 'test']], pubkey: 'pubkey1' }
      const { pubkey } = appIdToAddressObj(appId)
      // Override pubkey in mockEvent to match appId derived pubkey for the test to work
      mockEvent.pubkey = pubkey

      const mockGetUserRelays = mock.fn(async () => ({
        [pubkey]: {
          write: new Set(writeRelays)
        }
      }))
      const mockGetEventsByStrategy = mock.fn(async () => [mockEvent])

      const result = await AppFileDownloader.getSiteManifestEvents([appId], {
        _getUserRelays: mockGetUserRelays,
        _getEventsByStrategy: mockGetEventsByStrategy
      })

      assert.deepEqual(result[appId].event, mockEvent)
      assert.deepEqual(result[appId].writeRelays, writeRelays)
      assert.equal(mockGetUserRelays.mock.callCount(), 1)
      assert.equal(mockGetEventsByStrategy.mock.callCount(), 1)
    })
  })

  describe('run', () => {
    const createMockDeps = () => ({
      _FileDownloader: class MockFileDownloader {
        constructor (hash, pubkeysByRelay, callback, options) {
          this.hash = hash
          this.pubkeysByRelay = pubkeysByRelay
          this.callback = callback
          this.options = options
        }

        async run () {
          // Simulate some progress
          this.callback({ type: 'progress', progress: 50, count: 50, total: 100 })
          // Simulate event
          const event = { id: 'evt1', tags: [['c', `${this.hash}:50`, '100']] }
          await this.callback({ type: 'progress', progress: 51, count: 51, total: 100, event })

          return Promise.resolve()
        }
      },
      _countFileChunksFromDb: mock.fn(async () => ({ total: 100 })),
      _getFileChunksFromDb: mock.fn(async () => [[appId, 'hash', 0], [appId, 'hash', 1]]),
      _saveFileChunksToDB: mock.fn(async () => {})
    })

    it('should instantiate FileDownloader and yield progress (IRFS)', async () => {
      const testHash = 'test-hash'
      const downloader = new AppFileDownloader(appId, testHash, writeRelays, { service: 'irfs' })
      const deps = createMockDeps()

      const iterator = downloader.run(deps)
      const updates = []

      for await (const report of iterator) {
        updates.push(report)
      }

      assert.ok(updates.length >= 2)
      assert.equal(updates[0].progress, 50)
      assert.equal(updates[1].progress, 51)

      // Verify DB save called
      assert.equal(deps._saveFileChunksToDB.mock.callCount(), 1)

      // Verify FileDownloader options
      // We can't easily check the instance here unless we spy on the constructor
      // but the fact that run() yielded mocked data proves it was used.
    })

    it('should default to blossom service when no service option provided', () => {
      const downloader = new AppFileDownloader(appId, 'test-hash', writeRelays)
      assert.equal(downloader.service, 'blossom')
    })

    it('should accept blossom service option explicitly', () => {
      const downloader = new AppFileDownloader(appId, 'abc123', writeRelays, { service: 'blossom' })
      assert.equal(downloader.service, 'blossom')
    })

    it('should default mimeType to null', () => {
      const downloader = new AppFileDownloader(appId, 'abc123', writeRelays)
      assert.equal(downloader.mimeType, null)
    })

    it('should store mimeType option', () => {
      const downloader = new AppFileDownloader(appId, 'abc123', writeRelays, { mimeType: 'image/png' })
      assert.equal(downloader.mimeType, 'image/png')
    })
  })

  describe('run with blossom service', () => {
    it('should use BlossomFileDownloader when service is blossom and pass blossomFileHash to save', async () => {
      const blossomSha256Hash = 'abc123sha256hash'
      const downloader = new AppFileDownloader(appId, blossomSha256Hash, writeRelays, { service: 'blossom' })

      let capturedCallback, capturedOptions
      const MockBlossomDownloader = class {
        constructor (fileHash, pubkey, relays, callback, options) {
          this.fileHash = fileHash
          this.pubkey = pubkey
          capturedCallback = callback
          capturedOptions = options
        }

        async run () {
          // Simulate blossom download producing chunk events with fileHash in c tag (no merkle tree)
          const event1 = { kind: 34600, pubkey: this.pubkey, id: 'id1', tags: [['d', `${blossomSha256Hash}:0`], ['c', `${blossomSha256Hash}:0`, '2']], content: 'data', created_at: 1000 }
          const event2 = { kind: 34600, pubkey: this.pubkey, id: 'id2', tags: [['d', `${blossomSha256Hash}:1`], ['c', `${blossomSha256Hash}:1`, '2']], content: 'data', created_at: 1000 }
          await capturedCallback({ type: 'progress', progress: 50, count: 1, total: 2, chunkIndex: 0, event: event1 })
          await capturedCallback({ type: 'progress', progress: 100, count: 2, total: 2, chunkIndex: 1, event: event2 })
        }
      }

      const deps = {
        _BlossomFileDownloader: MockBlossomDownloader,
        _countFileChunksFromDb: mock.fn(async () => ({ total: null, count: 0 })),
        _saveFileChunksToDB: mock.fn(async () => {})
      }

      const updates = []
      for await (const report of downloader.run(deps)) {
        updates.push(report)
      }

      assert.ok(updates.length >= 2)
      assert.equal(updates[0].progress, 50)
      assert.equal(updates[1].progress, 100)

      // Verify chunk events were saved to DB
      assert.equal(deps._saveFileChunksToDB.mock.callCount(), 2)

      // Verify _saveFileChunksToDB was called with the sha256 hash in fakeManifest
      const firstSaveCall = deps._saveFileChunksToDB.mock.calls[0]
      const fakeManifest = firstSaveCall.arguments[0]
      const savedChunkEvents = firstSaveCall.arguments[1]
      const savedAppId = firstSaveCall.arguments[2]

      // Fake manifest should reference the sha256 hash (path tag: ['path', '', hash])
      assert.equal(fakeManifest.tags[0][2], blossomSha256Hash)
      // The chunk event's c tag should use fileHash as root (no merkle hash)
      const cTag = savedChunkEvents[0].tags.find(t => t[0] === 'c')
      assert.ok(cTag[1].startsWith(blossomSha256Hash + ':'), 'c tag should use blossom sha256 hash as root')
      assert.equal(savedAppId, appId)
      // Verify mimeType option is forwarded to BlossomFileDownloader
      assert.deepEqual(capturedOptions, { mimeType: null })
    })

    it('should skip download when already fully cached', async () => {
      const testHash = 'abc123hash'
      const downloader = new AppFileDownloader(appId, testHash, writeRelays, { service: 'blossom' })

      let blossomConstructorCalled = false
      const MockBlossomDownloader = class {
        constructor () { blossomConstructorCalled = true }
        async run () {}
      }

      const deps = {
        _BlossomFileDownloader: MockBlossomDownloader,
        _countFileChunksFromDb: mock.fn(async () => ({ total: 5, count: 5 })),
        _saveFileChunksToDB: mock.fn(async () => {})
      }

      const updates = []
      for await (const report of downloader.run(deps)) {
        updates.push(report)
      }

      assert.equal(blossomConstructorCalled, false)
      assert.equal(updates.length, 1)
      assert.equal(updates[0].progress, 100)
    })

    it('skipDb: true skips DB check/save and includes event in yielded items (blossom)', async () => {
      const blossomHash = 'deadbeef1234'
      const downloader = new AppFileDownloader(appId, blossomHash, writeRelays, { service: 'blossom' })

      let capturedCallback
      const MockBlossomDownloader = class {
        constructor (_hash, _pubkey, _relays, callback) { capturedCallback = callback }
        async run () {
          const event = { kind: 34600, pubkey: 'pk', id: 'id1', tags: [['c', `${blossomHash}:0`, '1']], content: 'data', created_at: 1000 }
          await capturedCallback({ type: 'progress', progress: 100, count: 1, total: 1, chunkIndex: 0, event })
        }
      }

      const saveToDb = mock.fn(async () => {})
      const countFromDb = mock.fn(async () => ({ total: null, count: 0 }))

      const updates = []
      for await (const report of downloader.run({
        _BlossomFileDownloader: MockBlossomDownloader,
        _countFileChunksFromDb: countFromDb,
        _saveFileChunksToDB: saveToDb,
        skipDb: true
      })) {
        updates.push(report)
      }

      // DB should not be checked or written
      assert.equal(countFromDb.mock.callCount(), 0)
      assert.equal(saveToDb.mock.callCount(), 0)

      // event should be present in yielded item
      assert.ok(updates.some(r => r.event?.id === 'id1'))
    })
  })
})
