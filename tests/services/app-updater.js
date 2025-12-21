import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import AppUpdater from '../../src/services/app-updater/index.js'

describe('AppUpdater', () => {
  describe('getInstalledAppIds', () => {
    it('should return unique app ids from all workspaces', () => {
      const mockLocalStorage = {
        getItem: mock.fn((key) => {
          if (key === 'session_workspaceKeys') return JSON.stringify(['ws1', 'ws2'])
          if (key === 'session_workspaceByKey_ws1_pinnedAppIds') return JSON.stringify(['app1', 'app2'])
          if (key === 'session_workspaceByKey_ws1_unpinnedAppIds') return JSON.stringify(['app3'])
          if (key === 'session_workspaceByKey_ws2_pinnedAppIds') return JSON.stringify(['app2']) // duplicate
          if (key === 'session_workspaceByKey_ws2_unpinnedAppIds') return JSON.stringify(['app4'])
          return null
        })
      }

      const result = AppUpdater.getInstalledAppIds({ _localStorage: mockLocalStorage })

      assert.deepEqual(result.sort(), ['app1', 'app2', 'app3', 'app4'].sort())
    })

    it('should handle empty storage gracefully', () => {
      const mockLocalStorage = {
        getItem: mock.fn(() => null)
      }

      const result = AppUpdater.getInstalledAppIds({ _localStorage: mockLocalStorage })
      assert.deepEqual(result, [])
    })
  })

  describe('searchForUpdates', () => {
    const appId = 'app1'

    it('should check for updates and mark hasUpdate=true when remote is newer', async () => {
      const localBundle = {
        id: 'local',
        created_at: 100,
        meta: { hasUpdate: false }
      }
      const remoteEvent = {
        id: 'remote',
        created_at: 200
      }

      const mockAppFileDownloader = {
        getBundleEvents: mock.fn(async () => ({
          [appId]: { event: remoteEvent }
        }))
      }
      const mockGetBundleFromDb = mock.fn(async () => localBundle)
      const mockSaveBundleToDb = mock.fn(async () => {})

      const updates = await AppUpdater.searchForUpdates([appId], {
        _AppFileDownloader: mockAppFileDownloader,
        _getBundleFromDb: mockGetBundleFromDb,
        _saveBundleToDb: mockSaveBundleToDb
      })

      assert.equal(mockAppFileDownloader.getBundleEvents.mock.callCount(), 1)
      assert.equal(mockGetBundleFromDb.mock.callCount(), 1)
      assert.equal(mockSaveBundleToDb.mock.callCount(), 1)

      const [, savedMeta] = mockSaveBundleToDb.mock.calls[0].arguments
      assert.equal(savedMeta.hasUpdate, true)
      assert.deepEqual(updates[appId].event, remoteEvent)
    })

    it('should mark hasUpdate=false when remote is older or same', async () => {
      const localBundle = {
        id: 'local',
        created_at: 200,
        meta: { hasUpdate: true } // currently marked as having update
      }
      const remoteEvent = {
        id: 'remote',
        created_at: 200
      }

      const mockAppFileDownloader = {
        getBundleEvents: mock.fn(async () => ({
          [appId]: { event: remoteEvent }
        }))
      }
      const mockGetBundleFromDb = mock.fn(async () => localBundle)
      const mockSaveBundleToDb = mock.fn(async () => {})

      const updates = await AppUpdater.searchForUpdates([appId], {
        _AppFileDownloader: mockAppFileDownloader,
        _getBundleFromDb: mockGetBundleFromDb,
        _saveBundleToDb: mockSaveBundleToDb
      })

      const [, savedMeta] = mockSaveBundleToDb.mock.calls[0].arguments
      assert.equal(savedMeta.hasUpdate, false)
      assert.equal(updates[appId], undefined)
    })

    it('should use getInstalledAppIds if no appIds provided', async () => {
      const mockLocalStorage = {
        getItem: mock.fn((key) => {
          if (key === 'session_workspaceKeys') return JSON.stringify(['ws1'])
          if (key === 'session_workspaceByKey_ws1_pinnedAppIds') return JSON.stringify([appId])
          return null
        })
      }

      const mockAppFileDownloader = {
        getBundleEvents: mock.fn(async () => ({}))
      }
      const mockGetBundleFromDb = mock.fn(async () => null)
      const mockSaveBundleToDb = mock.fn(async () => {})

      await AppUpdater.searchForUpdates(undefined, {
        _AppFileDownloader: mockAppFileDownloader,
        _getBundleFromDb: mockGetBundleFromDb,
        _saveBundleToDb: mockSaveBundleToDb,
        _localStorage: mockLocalStorage
      })

      assert.equal(mockAppFileDownloader.getBundleEvents.mock.callCount(), 1)
      assert.deepEqual(mockAppFileDownloader.getBundleEvents.mock.calls[0].arguments[0], [appId])
    })

    it('should mark hasUpdate=false when local bundle exists but no remote bundle found', async () => {
      const localBundle = {
        id: 'local',
        created_at: 100,
        meta: { hasUpdate: true }
      }

      const mockAppFileDownloader = {
        getBundleEvents: mock.fn(async () => ({}))
      }
      const mockGetBundleFromDb = mock.fn(async () => localBundle)
      const mockSaveBundleToDb = mock.fn(async () => {})

      const updates = await AppUpdater.searchForUpdates([appId], {
        _AppFileDownloader: mockAppFileDownloader,
        _getBundleFromDb: mockGetBundleFromDb,
        _saveBundleToDb: mockSaveBundleToDb
      })

      assert.equal(mockSaveBundleToDb.mock.callCount(), 1)
      const [, savedMeta] = mockSaveBundleToDb.mock.calls[0].arguments
      assert.equal(savedMeta.hasUpdate, false)
      assert.deepEqual(updates, {})
    })
  })

  describe('updateApp', () => {
    const nextBundleEvent = {
      kind: 37448,
      pubkey: 'pubkey1',
      tags: [
        ['d', 'app1'],
        ['file', 'hash1', 'file1.js'],
        ['file', 'hash2', 'file2.css']
      ]
    }
    const appId = 'app1_id'
    const writeRelays = ['wss://relay1.com']

    it('should download files sequentially and update db on success', async () => {
      const mockDownloaderInstance = {
        run: async function * () {
          yield { progress: 50, error: null }
          yield { progress: 100, error: null }
        }
      }
      const MockAppFileDownloader = class {
        constructor () { return mockDownloaderInstance }
      }

      const mockDeleteStale = mock.fn(async () => {})
      const mockSaveBundle = mock.fn(async () => {})
      const mockGetBundle = mock.fn(async () => ({ meta: { lastOpenedAsSingleNappAt: 123 } }))
      const mockAddressToId = mock.fn(() => appId)

      const iterator = AppUpdater.updateApp(nextBundleEvent, {
        _AppFileDownloader: MockAppFileDownloader,
        _deleteStaleFileChunksFromDb: mockDeleteStale,
        _saveBundleToDb: mockSaveBundle,
        _getBundleFromDb: mockGetBundle,
        _addressObjToAppId: mockAddressToId,
        writeRelays
      })

      const reports = []
      for await (const report of iterator) {
        reports.push(report)
      }

      // Check progress reports
      // File 1: 50% -> app: 25%
      // File 1: 100% -> app: 50%
      // File 2: 50% -> app: 75%
      // File 2: 100% -> app: 100%
      assert.equal(reports.length, 4)
      assert.equal(reports[3].appProgress, 100)
      assert.equal(reports[3].error, null)

      // Check DB calls
      assert.equal(mockDeleteStale.mock.callCount(), 1)
      assert.deepEqual(mockDeleteStale.mock.calls[0].arguments, [appId, ['hash1', 'hash2']])

      assert.equal(mockSaveBundle.mock.callCount(), 1)
      const [savedEvent, savedMeta] = mockSaveBundle.mock.calls[0].arguments
      assert.deepEqual(savedEvent, nextBundleEvent)
      assert.equal(savedMeta.hasUpdate, false)
      assert.equal(savedMeta.lastOpenedAsSingleNappAt, 123)
    })

    it('should stop on download error', async () => {
      const error = new Error('Download failed')
      const mockDownloaderInstance = {
        run: async function * () {
          yield { progress: 0, error }
        }
      }
      const MockAppFileDownloader = class {
        constructor () { return mockDownloaderInstance }
      }

      const mockDeleteStale = mock.fn(async () => {})
      const mockSaveBundle = mock.fn(async () => {})
      const mockAddressToId = mock.fn(() => appId)

      const iterator = AppUpdater.updateApp(nextBundleEvent, {
        _AppFileDownloader: MockAppFileDownloader,
        _deleteStaleFileChunksFromDb: mockDeleteStale,
        _saveBundleToDb: mockSaveBundle,
        _addressObjToAppId: mockAddressToId,
        writeRelays
      })

      const reports = []
      for await (const report of iterator) {
        reports.push(report)
      }

      assert.equal(reports.length, 1)
      assert.equal(reports[0].error, error)
      assert.equal(mockDeleteStale.mock.callCount(), 0)
      assert.equal(mockSaveBundle.mock.callCount(), 0)
    })

    it('should fetch relays if not provided', async () => {
      const mockDownloaderInstance = {
        run: async function * () { yield { progress: 100, error: null } }
      }
      const MockAppFileDownloader = class {
        constructor () { return mockDownloaderInstance }
      }
      const mockGetUserRelays = mock.fn(async () => ({
        [nextBundleEvent.pubkey]: { write: new Set(['wss://fetched-relay.com']) }
      }))
      const mockAddressToId = mock.fn(() => appId)
      const mockDeleteStale = mock.fn(async () => {})
      const mockSaveBundle = mock.fn(async () => {})
      const mockGetBundle = mock.fn(async () => ({}))

      const iterator = AppUpdater.updateApp(nextBundleEvent, {
        _AppFileDownloader: MockAppFileDownloader,
        _getUserRelays: mockGetUserRelays,
        _addressObjToAppId: mockAddressToId,
        _deleteStaleFileChunksFromDb: mockDeleteStale,
        _saveBundleToDb: mockSaveBundle,
        _getBundleFromDb: mockGetBundle
      })

      for await (const _ of iterator) {
        // consume iterator
      }

      assert.equal(mockGetUserRelays.mock.callCount(), 1)
    })
  })

  describe('updateApps', () => {
    const event1 = { kind: 1, pubkey: 'pk1', tags: [['d', 'app1']] }
    const event2 = { kind: 1, pubkey: 'pk2', tags: [['d', 'app2']] }
    const appId1 = 'id1'
    const appId2 = 'id2'

    it('should update apps sequentially and report overall progress', async () => {
      const mockUpdateApp = mock.fn(async function * (event) {
        if (event === event1) {
          yield { appProgress: 50, fileProgress: 50, error: null }
          yield { appProgress: 100, fileProgress: 100, error: null }
        } else {
          yield { appProgress: 100, fileProgress: 100, error: null }
        }
      })

      const mockAddressToId = mock.fn(({ dTag }) => dTag === 'app1' ? appId1 : appId2)

      const iterator = AppUpdater.updateApps([event1, event2], {
        _updateApp: mockUpdateApp,
        _addressObjToAppId: mockAddressToId
      })

      const reports = []
      for await (const report of iterator) {
        reports.push(report)
      }

      // App 1 (index 0):
      // Report 1: appProgress 50 -> overall: (0*100 + 50)/2 = 25
      // Report 2: appProgress 100 -> overall: (0*100 + 100)/2 = 50

      // App 2 (index 1):
      // Report 3: appProgress 100 -> overall: (1*100 + 100)/2 = 100

      assert.equal(reports.length, 3)

      assert.equal(reports[0].appId, appId1)
      assert.equal(reports[0].overallProgress, 25)

      assert.equal(reports[1].appId, appId1)
      assert.equal(reports[1].overallProgress, 50)

      assert.equal(reports[2].appId, appId2)
      assert.equal(reports[2].overallProgress, 100)

      assert.equal(mockUpdateApp.mock.callCount(), 2)
    })

    it('should continue to next app on error', async () => {
      const error = new Error('Update failed')
      const mockUpdateApp = mock.fn(async function * (event) {
        if (event === event1) {
          throw error
        } else {
          yield { appProgress: 100, fileProgress: 100, error: null }
        }
      })

      const mockAddressToId = mock.fn(({ dTag }) => dTag === 'app1' ? appId1 : appId2)

      const iterator = AppUpdater.updateApps([event1, event2], {
        _updateApp: mockUpdateApp,
        _addressObjToAppId: mockAddressToId
      })

      const reports = []
      for await (const report of iterator) {
        reports.push(report)
      }

      assert.equal(reports.length, 2)

      assert.equal(reports[0].appId, appId1)
      assert.equal(reports[0].error, error)
      assert.equal(reports[0].overallProgress, 0)

      assert.equal(reports[1].appId, appId2)
      assert.equal(reports[1].error, null)
      assert.equal(reports[1].overallProgress, 100)
    })
  })

  describe('isAppOpen', () => {
    it('should return true if app is open in any workspace', () => {
      const mockLocalStorage = {
        getItem: mock.fn((key) => {
          if (key === 'session_workspaceKeys') return JSON.stringify(['ws1'])
          if (key === 'session_workspaceByKey_ws1_openAppKeys') return JSON.stringify(['key1'])
          if (key === 'session_workspaceByKey_ws1_appById_app1_appKeys') return JSON.stringify(['key1'])
          return null
        })
      }
      assert.equal(AppUpdater.isAppOpen('app1', { _localStorage: mockLocalStorage }), true)
    })

    it('should return false if app is not open', () => {
      const mockLocalStorage = {
        getItem: mock.fn((key) => {
          if (key === 'session_workspaceKeys') return JSON.stringify(['ws1'])
          if (key === 'session_workspaceByKey_ws1_openAppKeys') return JSON.stringify(['key2'])
          if (key === 'session_workspaceByKey_ws1_appById_app1_appKeys') return JSON.stringify(['key1'])
          return null
        })
      }
      assert.equal(AppUpdater.isAppOpen('app1', { _localStorage: mockLocalStorage }), false)
    })

    it('should return false if storage is missing', () => {
      assert.equal(AppUpdater.isAppOpen('app1', { _localStorage: null }), false)
    })
  })

  describe('scheduleCleanup', () => {
    it('should request lock and cleanup closed apps', async () => {
      const mockNavigator = {
        locks: {
          request: mock.fn(async (name, options, callback) => {
            return callback({ name })
          })
        }
      }
      // Mock isAppOpen to return false (closed)
      const mockLocalStorage = {
        getItem: mock.fn(() => JSON.stringify([]))
      }
      const mockGetBundle = mock.fn(async () => ({ tags: [['file', 'hash1']] }))
      const mockDeleteStale = mock.fn(async () => {})

      await AppUpdater.scheduleCleanup(['app1'], {
        _navigator: mockNavigator,
        _localStorage: mockLocalStorage,
        _getBundleFromDb: mockGetBundle,
        _deleteStaleFileChunksFromDb: mockDeleteStale
      })

      assert.equal(mockNavigator.locks.request.mock.callCount(), 1)
      assert.equal(mockDeleteStale.mock.callCount(), 1)
      assert.deepEqual(mockDeleteStale.mock.calls[0].arguments, ['app1', ['hash1']])
    })

    it('should reschedule if app is open', async () => {
      const mockNavigator = {
        locks: {
          request: mock.fn(async (name, options, callback) => {
            return callback({ name })
          })
        }
      }
      // Mock isAppOpen to return true (open)
      const mockLocalStorage = {
        getItem: mock.fn((key) => {
          if (key === 'session_workspaceKeys') return JSON.stringify(['ws1'])
          if (key.includes('openAppKeys')) return JSON.stringify(['key1'])
          if (key.includes('appById_app1_appKeys')) return JSON.stringify(['key1'])
          return null
        })
      }
      const mockSetTimeout = mock.fn()
      const mockDeleteStale = mock.fn()

      await AppUpdater.scheduleCleanup(['app1'], {
        _navigator: mockNavigator,
        _localStorage: mockLocalStorage,
        _setTimeout: mockSetTimeout,
        _deleteStaleFileChunksFromDb: mockDeleteStale
      })

      assert.equal(mockDeleteStale.mock.callCount(), 0)
      assert.equal(mockSetTimeout.mock.callCount(), 1)
    })

    it('should respect ifAvailable option and skip if lock not acquired', async () => {
      const mockNavigator = {
        locks: {
          request: mock.fn(async (name, options, callback) => {
            assert.equal(options.ifAvailable, true)
            return callback(null) // Lock not available
          })
        }
      }
      const mockDeleteStale = mock.fn()

      await AppUpdater.scheduleCleanup(['app1'], {
        _navigator: mockNavigator,
        _deleteStaleFileChunksFromDb: mockDeleteStale,
        ifAvailable: true
      })

      assert.equal(mockDeleteStale.mock.callCount(), 0)
    })
  })

  describe('initCleanupJob', () => {
    it('should schedule cleanup after delay', () => {
      const mockSetTimeout = mock.fn((cb) => cb())
      const originalScheduleCleanup = AppUpdater.scheduleCleanup
      const mockScheduleCleanup = mock.fn()
      AppUpdater.scheduleCleanup = mockScheduleCleanup

      try {
        AppUpdater.initCleanupJob({ _setTimeout: mockSetTimeout })
        assert.equal(mockSetTimeout.mock.callCount(), 1)
        assert.equal(mockScheduleCleanup.mock.callCount(), 1)
        assert.equal(mockScheduleCleanup.mock.calls[0].arguments[1].ifAvailable, true)
      } finally {
        AppUpdater.scheduleCleanup = originalScheduleCleanup
      }
    })
  })
})
