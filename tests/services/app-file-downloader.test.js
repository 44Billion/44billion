import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import AppFileDownloader from '../../src/services/app-file-downloader/index.js'
import { appIdToAddressObj } from '../../src/helpers/app.js'

describe('AppFileDownloader', () => {
  // valid appId with 43 chars for pubkey (base62)
  const appId = 'a0000000000000000000000000000000000000000000test'
  const writeRelays = ['wss://relay1.com', 'wss://relay2.com', 'wss://relay3.com']

  describe('getBundleEvents', () => {
    it('should fetch bundle events and return them grouped by appId', async () => {
      const mockEvent = { id: 'bundle1', kind: 37448, tags: [['d', 'test']], pubkey: 'pubkey1' }
      const { pubkey } = appIdToAddressObj(appId)
      // Override pubkey in mockEvent to match appId derived pubkey for the test to work
      mockEvent.pubkey = pubkey

      const mockGetUserRelays = mock.fn(async () => ({
        [pubkey]: {
          write: new Set(writeRelays)
        }
      }))
      const mockGetEventsByStrategy = mock.fn(async () => [mockEvent])

      const result = await AppFileDownloader.getBundleEvents([appId], {
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

    it('should instantiate FileDownloader and yield progress', async () => {
      const testHash = 'test-hash'
      const downloader = new AppFileDownloader(appId, testHash, writeRelays)
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
  })
})
