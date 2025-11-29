import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import AppFileDownloader from '../../src/services/app-file-downloader/index.js'
import { appIdToAddressObj } from '../../src/helpers/app.js'

describe('AppFileDownloader', () => {
  // valid appId with 43 chars for pubkey (base62)
  const appId = 'a0000000000000000000000000000000000000000000test'
  const fileRootHash = 'hash123'
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
      _nostrRelays: {
        getEvents: mock.fn(async () => ({ result: [] }))
      },
      _countFileChunksFromDb: mock.fn(async () => ({ total: null })),
      _getFileChunksFromDb: mock.fn(async () => []),
      _saveFileChunksToDB: mock.fn(async () => {})
    })

    it('should download all chunks successfully (happy path)', async () => {
      const downloader = new AppFileDownloader(appId, fileRootHash, writeRelays)
      const deps = createMockDeps()
      const totalChunks = 60

      deps._nostrRelays.getEvents.mock.mockImplementation(async (filter) => {
        const requestedIndexes = filter['#c'].map(c => parseInt(c.split(':')[1]))
        const events = requestedIndexes.map(idx => ({
          kind: 34600,
          tags: [
            ['c', `${fileRootHash}:${idx}`, String(totalChunks)],
            ['d', String(idx)]
          ]
        }))
        return { result: events }
      })

      const iterator = downloader.run(deps)
      let lastProgress = 0

      for await (const report of iterator) {
        if (report.error) throw report.error
        lastProgress = report.progress
      }

      assert.equal(lastProgress, 100)
      assert.ok(deps._nostrRelays.getEvents.mock.callCount() > 0)
      assert.ok(deps._saveFileChunksToDB.mock.callCount() > 0)
    })

    it('should handle missing chunks on some relays and recover', async () => {
      const downloader = new AppFileDownloader(appId, fileRootHash, writeRelays)
      const deps = createMockDeps()
      const totalChunks = 10
      const missingChunkIdx = 5
      const missingRelay = writeRelays[0]

      deps._nostrRelays.getEvents.mock.mockImplementation(async (filter, relays) => {
        const relayUrl = relays[0]
        const requestedIndexes = filter['#c'].map(c => parseInt(c.split(':')[1]))

        const events = requestedIndexes
          .filter(idx => !(relayUrl === missingRelay && idx === missingChunkIdx))
          .map(idx => ({
            kind: 34600,
            tags: [
              ['c', `${fileRootHash}:${idx}`, String(totalChunks)],
              ['d', String(idx)]
            ]
          }))

        return { result: events }
      })

      const iterator = downloader.run(deps)
      let lastProgress = 0

      for await (const report of iterator) {
        if (report.error) throw report.error
        lastProgress = report.progress
      }

      assert.equal(lastProgress, 100)
      // Verify that we eventually got the missing chunk from another relay
      // This is implicitly tested by reaching 100% progress without error
    })

    it('should error when a chunk is missing from all relays', async () => {
      const downloader = new AppFileDownloader(appId, fileRootHash, writeRelays)
      const deps = createMockDeps()
      const totalChunks = 10
      const missingChunkIdx = 5

      deps._nostrRelays.getEvents.mock.mockImplementation(async (filter) => {
        const requestedIndexes = filter['#c'].map(c => parseInt(c.split(':')[1]))

        const events = requestedIndexes
          .filter(idx => idx !== missingChunkIdx)
          .map(idx => ({
            kind: 34600,
            tags: [
              ['c', `${fileRootHash}:${idx}`, String(totalChunks)],
              ['d', String(idx)]
            ]
          }))

        return { result: events }
      })

      const iterator = downloader.run(deps)
      let error = null
      let lastProgress = 0

      for await (const report of iterator) {
        lastProgress = report.progress
        if (report.error) {
          error = report.error
          break
        }
      }

      assert.ok(error)
      assert.match(error.message, /Chunks missing from all relays/)
      assert.ok(lastProgress < 100)
    })

    it('should coordinate multiple instances to download chunks faster', async () => {
      const downloader1 = new AppFileDownloader(appId, fileRootHash, writeRelays)
      const downloader2 = new AppFileDownloader(appId, fileRootHash, writeRelays)
      const deps = createMockDeps()
      const totalChunks = 100

      deps._nostrRelays.getEvents.mock.mockImplementation(async (filter) => {
        await new Promise(resolve => setTimeout(resolve, 10))
        const requestedIndexes = filter['#c'].map(c => parseInt(c.split(':')[1]))
        const events = requestedIndexes.map(idx => ({
          kind: 34600,
          tags: [
            ['c', `${fileRootHash}:${idx}`, String(totalChunks)],
            ['d', String(idx)]
          ]
        }))
        return { result: events }
      })

      const runDownloader = async (dl) => {
        const iterator = dl.run(deps)
        let lastProgress = 0
        for await (const report of iterator) {
          if (report.error) throw report.error
          lastProgress = report.progress
        }
        return lastProgress
      }

      const [res1, res2] = await Promise.all([
        runDownloader(downloader1),
        runDownloader(downloader2)
      ])

      assert.equal(res1, 100)
      assert.equal(res2, 100)
    })
  })
})
