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

    it('should set latestUpdateEventId when remote is newer', async () => {
      const localManifest = {
        id: 'local',
        created_at: 100,
        meta: {}
      }
      const remoteEvent = {
        id: 'remote',
        created_at: 200
      }

      const mockAppFileDownloader = {
        getSiteManifestEvents: mock.fn(async () => ({
          [appId]: { event: remoteEvent }
        }))
      }

      // Stateful mock to simulate DB updates
      let storedManifest = localManifest
      const mockGetManifestFromDb = mock.fn(async () => storedManifest)
      const mockSaveManifestToDb = mock.fn(async (manifest, meta) => {
        storedManifest = { ...manifest, meta }
      })

      const mockLocalStorage = {
        getItem: mock.fn((key) => {
          if (key === 'session_workspaceKeys') return JSON.stringify(['ws1'])
          if (key === 'session_workspaceByKey_ws1_pinnedAppIds') return JSON.stringify([appId])
          return null
        })
      }

      const updates = await AppUpdater.searchForUpdates([appId], {
        _AppFileDownloader: mockAppFileDownloader,
        _getSiteManifestFromDb: mockGetManifestFromDb,
        _saveSiteManifestToDb: mockSaveManifestToDb,
        _localStorage: mockLocalStorage
      })

      assert.equal(mockAppFileDownloader.getSiteManifestEvents.mock.callCount(), 1)
      assert.equal(mockGetManifestFromDb.mock.callCount(), 1)
      assert.equal(mockSaveManifestToDb.mock.callCount(), 1)

      const [, savedMeta] = mockSaveManifestToDb.mock.calls[0].arguments
      assert.equal(savedMeta.latestUpdateEventId, 'remote')
      assert.deepEqual(updates[appId].event, remoteEvent)
    })

    it('should clear latestUpdateEventId when remote is older or same', async () => {
      const localManifest = {
        id: 'local',
        created_at: 200,
        meta: { latestUpdateEventId: 'old-remote' }
      }
      const remoteEvent = {
        id: 'remote',
        created_at: 200
      }

      const mockAppFileDownloader = {
        getSiteManifestEvents: mock.fn(async () => ({
          [appId]: { event: remoteEvent }
        }))
      }
      const mockGetManifestFromDb = mock.fn(async () => localManifest)
      const mockSaveManifestToDb = mock.fn(async () => {})
      const mockLocalStorage = { getItem: mock.fn(() => '[]') }

      const updates = await AppUpdater.searchForUpdates([appId], {
        _AppFileDownloader: mockAppFileDownloader,
        _getSiteManifestFromDb: mockGetManifestFromDb,
        _saveSiteManifestToDb: mockSaveManifestToDb,
        _localStorage: mockLocalStorage
      })

      const [, savedMeta] = mockSaveManifestToDb.mock.calls[0].arguments
      assert.equal(savedMeta.latestUpdateEventId, null)
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
        getSiteManifestEvents: mock.fn(async () => ({}))
      }
      const mockGetManifestFromDb = mock.fn(async () => null)
      const mockSaveManifestToDb = mock.fn(async () => {})

      await AppUpdater.searchForUpdates(undefined, {
        _AppFileDownloader: mockAppFileDownloader,
        _getSiteManifestFromDb: mockGetManifestFromDb,
        _saveSiteManifestToDb: mockSaveManifestToDb,
        _localStorage: mockLocalStorage
      })

      assert.equal(mockAppFileDownloader.getSiteManifestEvents.mock.callCount(), 1)
      assert.deepEqual(mockAppFileDownloader.getSiteManifestEvents.mock.calls[0].arguments[0], [appId])
    })

    it('should clear latestUpdateEventId when local manifest exists but no remote manifest found', async () => {
      const localManifest = {
        id: 'local',
        created_at: 100,
        meta: { latestUpdateEventId: 'old-remote' }
      }

      const mockAppFileDownloader = {
        getSiteManifestEvents: mock.fn(async () => ({}))
      }
      const mockGetManifestFromDb = mock.fn(async () => localManifest)
      const mockSaveManifestToDb = mock.fn(async () => {})
      const mockLocalStorage = {
        getItem: mock.fn((key) => {
          if (key === 'session_workspaceKeys') return JSON.stringify(['ws1'])
          if (key === 'session_workspaceByKey_ws1_pinnedAppIds') return JSON.stringify([appId])
          return null
        })
      }

      const updates = await AppUpdater.searchForUpdates([appId], {
        _AppFileDownloader: mockAppFileDownloader,
        _getSiteManifestFromDb: mockGetManifestFromDb,
        _saveSiteManifestToDb: mockSaveManifestToDb,
        _localStorage: mockLocalStorage
      })

      assert.equal(mockSaveManifestToDb.mock.callCount(), 1)
      const [, savedMeta] = mockSaveManifestToDb.mock.calls[0].arguments
      assert.equal(savedMeta.latestUpdateEventId, null)
      assert.deepEqual(updates, {})
    })

    it('should share promise for same appIds (including implicit all)', async () => {
      const mockAppFileDownloader = {
        getSiteManifestEvents: mock.fn(async () => ({}))
      }
      const mockGetManifestFromDb = mock.fn(async () => null)
      const mockSaveManifestToDb = mock.fn(async () => {})

      const mockLocalStorage = {
        getItem: mock.fn((key) => {
          if (key === 'session_workspaceKeys') return JSON.stringify(['ws1'])
          if (key === 'session_workspaceByKey_ws1_pinnedAppIds') return JSON.stringify(['app1'])
          return null
        })
      }

      const deps = {
        _AppFileDownloader: mockAppFileDownloader,
        _getSiteManifestFromDb: mockGetManifestFromDb,
        _saveSiteManifestToDb: mockSaveManifestToDb,
        _localStorage: mockLocalStorage
      }

      // Call 1: Explicit list
      const p1 = AppUpdater.searchForUpdates(['app1'], deps)

      // Call 2: Implicit list (should resolve to ['app1'] and match key)
      const p2 = AppUpdater.searchForUpdates(null, deps)

      assert.equal(p1, p2)

      await p1
    })
  })

  describe('refreshUnreadCount', () => {
    const mockLocalStorage = {
      getItem: mock.fn((key) => {
        if (key === 'session_workspaceKeys') return JSON.stringify(['ws1'])
        if (key === 'session_workspaceByKey_ws1_pinnedAppIds') return JSON.stringify(['app1', 'app2', 'app3'])
        if (key === 'session_workspaceByKey_ws1_unpinnedAppIds') return JSON.stringify([])
        return null
      })
    }

    it('counts only updates whose latest event id differs from the seen one', async () => {
      const manifests = {
        app1: { meta: { latestUpdateEventId: 'a', seenUpdateEventId: null } }, // unseen
        app2: { meta: { latestUpdateEventId: 'b', seenUpdateEventId: 'b' } }, // seen
        app3: { meta: { latestUpdateEventId: null, seenUpdateEventId: null } } // none
      }
      const mockGet = mock.fn(async (id) => manifests[id])
      const mockSet = mock.fn()

      AppUpdater.isUserViewingUpdates = false
      await AppUpdater.refreshUnreadCount({
        _getSiteManifestFromDb: mockGet,
        _setWebStorageItem: mockSet,
        _localStorage: mockLocalStorage
      })

      assert.equal(mockSet.mock.callCount(), 1)
      assert.equal(mockSet.mock.calls[0].arguments[1], 'session_unread_appUpdateCount')
      assert.equal(mockSet.mock.calls[0].arguments[2], 1)
    })

    it('writes undefined when no updates are unseen', async () => {
      const manifests = {
        app1: { meta: { latestUpdateEventId: 'a', seenUpdateEventId: 'a' } },
        app2: { meta: { latestUpdateEventId: null } },
        app3: { meta: {} }
      }
      const mockGet = mock.fn(async (id) => manifests[id])
      const mockSet = mock.fn()

      AppUpdater.isUserViewingUpdates = false
      await AppUpdater.refreshUnreadCount({
        _getSiteManifestFromDb: mockGet,
        _setWebStorageItem: mockSet,
        _localStorage: mockLocalStorage
      })

      assert.equal(mockSet.mock.calls[0].arguments[2], undefined)
    })

    it('writes undefined while the user is viewing the updates page', async () => {
      const mockGet = mock.fn()
      const mockSet = mock.fn()

      AppUpdater.isUserViewingUpdates = true
      try {
        await AppUpdater.refreshUnreadCount({
          _getSiteManifestFromDb: mockGet,
          _setWebStorageItem: mockSet,
          _localStorage: mockLocalStorage
        })
      } finally {
        AppUpdater.isUserViewingUpdates = false
      }

      assert.equal(mockGet.mock.callCount(), 0) // short-circuits before reading
      assert.equal(mockSet.mock.callCount(), 1)
      assert.equal(mockSet.mock.calls[0].arguments[2], undefined)
    })
  })

  describe('markUpdateAsSeen', () => {
    it('saves the seenUpdateEventId on the manifest', async () => {
      const manifest = { id: 'm', meta: { latestUpdateEventId: 'a' } }
      const mockGet = mock.fn(async () => manifest)
      const mockSave = mock.fn(async () => {})

      await AppUpdater.markUpdateAsSeen('app1', 'a', {
        _getSiteManifestFromDb: mockGet,
        _saveSiteManifestToDb: mockSave
      })

      assert.equal(mockSave.mock.callCount(), 1)
      const [, savedMeta] = mockSave.mock.calls[0].arguments
      assert.equal(savedMeta.seenUpdateEventId, 'a')
      assert.equal(savedMeta.latestUpdateEventId, 'a')
    })

    it('is a no-op when the seenUpdateEventId already matches', async () => {
      const manifest = { id: 'm', meta: { latestUpdateEventId: 'a', seenUpdateEventId: 'a' } }
      const mockGet = mock.fn(async () => manifest)
      const mockSave = mock.fn(async () => {})

      await AppUpdater.markUpdateAsSeen('app1', 'a', {
        _getSiteManifestFromDb: mockGet,
        _saveSiteManifestToDb: mockSave
      })

      assert.equal(mockSave.mock.callCount(), 0)
    })

    it('is a no-op when no manifest exists', async () => {
      const mockGet = mock.fn(async () => null)
      const mockSave = mock.fn(async () => {})

      await AppUpdater.markUpdateAsSeen('app1', 'a', {
        _getSiteManifestFromDb: mockGet,
        _saveSiteManifestToDb: mockSave
      })

      assert.equal(mockSave.mock.callCount(), 0)
    })
  })

  describe('_appUpdateMode', () => {
    it('defaults to "always" when not set', () => {
      const ls = { getItem: mock.fn(() => null) }
      assert.equal(AppUpdater._appUpdateMode({ _localStorage: ls }), 'always')
    })
    it('returns the parsed mode for known values', () => {
      for (const mode of ['always', 'wifi', 'manual']) {
        const ls = { getItem: mock.fn(() => JSON.stringify(mode)) }
        assert.equal(AppUpdater._appUpdateMode({ _localStorage: ls }), mode)
      }
    })
    it('falls back to "always" for unknown or malformed values', () => {
      const unknown = { getItem: mock.fn(() => '"bogus"') }
      assert.equal(AppUpdater._appUpdateMode({ _localStorage: unknown }), 'always')
      const broken = { getItem: mock.fn(() => '{not json') }
      assert.equal(AppUpdater._appUpdateMode({ _localStorage: broken }), 'always')
    })
  })

  describe('update concurrency queue', () => {
    it('serializes updateApp calls so the second yields queued until the first releases', async () => {
      const originalMax = AppUpdater.MAX_CONCURRENT_UPDATES
      AppUpdater.MAX_CONCURRENT_UPDATES = 1
      AppUpdater._activeUpdates = 0
      AppUpdater._updateQueue = []

      const event = { kind: 35128, pubkey: 'pk', tags: [['d', 'app1'], ['path', 'f', 'h']] }

      // The first call's downloader is a deferred async iterator we hold paused
      // so the slot stays held until we explicitly release.
      let resolveFirstDownload
      const firstDownloadPromise = new Promise(resolve => { resolveFirstDownload = resolve })
      const firstDownloader = {
        run: async function * () {
          await firstDownloadPromise
          yield { progress: 100, error: null }
        }
      }
      const secondDownloader = {
        run: async function * () { yield { progress: 100, error: null } }
      }

      let downloaderIndex = 0
      const MockAppFileDownloader = class {
        constructor () {
          return downloaderIndex++ === 0 ? firstDownloader : secondDownloader
        }
      }

      const baseDeps = {
        _AppFileDownloader: MockAppFileDownloader,
        _deleteStaleFileChunksFromDb: async () => {},
        _saveSiteManifestToDb: async () => {},
        _getSiteManifestFromDb: async () => ({}),
        _addressObjToAppId: () => 'app1',
        writeRelays: ['wss://r']
      }

      try {
        const it1 = AppUpdater.updateApp(event, baseDeps)
        const it2 = AppUpdater.updateApp(event, baseDeps)

        // Both yield the queued report up-front.
        const r1Queued = await it1.next()
        const r2Queued = await it2.next()
        assert.equal(r1Queued.value.queued, true)
        assert.equal(r2Queued.value.queued, true)

        // Pump it1 once: it acquires the slot and starts downloading,
        // but firstDownloadPromise is still unresolved so it suspends inside run().
        const it1NextPromise = it1.next()

        // While it1 holds the slot, asking it2 for its next value must not yield
        // a non-queued report — it's waiting on _acquireUpdateSlot.
        const it2NextPromise = it2.next()
        // Race against a microtask-flushing promise to confirm it2 is pending.
        const sentinel = Symbol('pending')
        const winner = await Promise.race([
          it2NextPromise.then(v => v),
          Promise.resolve().then(() => Promise.resolve()).then(() => sentinel)
        ])
        assert.equal(winner, sentinel, 'it2 should still be waiting for the slot')

        // Let it1 finish, then drain both.
        resolveFirstDownload()
        await it1NextPromise
        for await (const _ of it1) { /* drain */ }
        // Now it2 should proceed.
        const r2First = await it2NextPromise
        assert.equal(r2First.value.queued, undefined)
        for await (const _ of it2) { /* drain */ }

        // Slot accounting back to zero.
        assert.equal(AppUpdater._activeUpdates, 0)
        assert.equal(AppUpdater._updateQueue.length, 0)
      } finally {
        AppUpdater.MAX_CONCURRENT_UPDATES = originalMax
      }
    })

    it('releases the slot when the generator throws or returns early', async () => {
      const originalMax = AppUpdater.MAX_CONCURRENT_UPDATES
      AppUpdater.MAX_CONCURRENT_UPDATES = 1
      AppUpdater._activeUpdates = 0
      AppUpdater._updateQueue = []

      const event = { kind: 35128, pubkey: 'pk', tags: [['d', 'app1'], ['path', 'f', 'h']] }
      const error = new Error('boom')
      const downloader = {
        run: async function * () { yield { progress: 0, error } }
      }
      const MockAppFileDownloader = class { constructor () { return downloader } }

      try {
        const it = AppUpdater.updateApp(event, {
          _AppFileDownloader: MockAppFileDownloader,
          _deleteStaleFileChunksFromDb: async () => {},
          _saveSiteManifestToDb: async () => {},
          _getSiteManifestFromDb: async () => ({}),
          _addressObjToAppId: () => 'app1',
          writeRelays: ['wss://r']
        })
        for await (const _ of it) { /* drain */ }
        assert.equal(AppUpdater._activeUpdates, 0)
      } finally {
        AppUpdater.MAX_CONCURRENT_UPDATES = originalMax
      }
    })
  })

  describe('updateApp', () => {
    const nextSiteManifestEvent = {
      kind: 35128,
      pubkey: 'pubkey1',
      tags: [
        ['d', 'app1'],
        ['path', 'file1.js', 'hash1'],
        ['path', 'file2.css', 'hash2']
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
      const mockSaveManifest = mock.fn(async () => {})
      const mockGetManifest = mock.fn(async () => ({ meta: { lastOpenedAsSingleNappAt: 123 } }))
      const mockAddressToId = mock.fn(() => appId)

      const iterator = AppUpdater.updateApp(nextSiteManifestEvent, {
        _AppFileDownloader: MockAppFileDownloader,
        _deleteStaleFileChunksFromDb: mockDeleteStale,
        _saveSiteManifestToDb: mockSaveManifest,
        _getSiteManifestFromDb: mockGetManifest,
        _addressObjToAppId: mockAddressToId,
        writeRelays
      })

      const reports = []
      for await (const report of iterator) {
        reports.push(report)
      }

      // 1 queued report + 4 progress reports
      // File 1: 50% -> app: 25%
      // File 1: 100% -> app: 50%
      // File 2: 50% -> app: 75%
      // File 2: 100% -> app: 100%
      assert.equal(reports.length, 5)
      assert.equal(reports[0].queued, true)
      assert.equal(reports[4].appProgress, 100)
      assert.equal(reports[4].error, null)

      // Check DB calls
      assert.equal(mockDeleteStale.mock.callCount(), 1)
      assert.deepEqual(mockDeleteStale.mock.calls[0].arguments, [appId, ['hash1', 'hash2']])

      assert.equal(mockSaveManifest.mock.callCount(), 1)
      const [savedEvent, savedMeta] = mockSaveManifest.mock.calls[0].arguments
      assert.deepEqual(savedEvent, nextSiteManifestEvent)
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
      const mockSaveManifest = mock.fn(async () => {})
      const mockAddressToId = mock.fn(() => appId)

      const iterator = AppUpdater.updateApp(nextSiteManifestEvent, {
        _AppFileDownloader: MockAppFileDownloader,
        _deleteStaleFileChunksFromDb: mockDeleteStale,
        _saveSiteManifestToDb: mockSaveManifest,
        _addressObjToAppId: mockAddressToId,
        writeRelays
      })

      const reports = []
      for await (const report of iterator) {
        reports.push(report)
      }

      // 1 queued report + 1 error report
      assert.equal(reports.length, 2)
      assert.equal(reports[0].queued, true)
      assert.equal(reports[1].error, error)
      assert.equal(mockDeleteStale.mock.callCount(), 0)
      assert.equal(mockSaveManifest.mock.callCount(), 0)
    })

    it('should fetch relays if not provided', async () => {
      const mockDownloaderInstance = {
        run: async function * () { yield { progress: 100, error: null } }
      }
      const MockAppFileDownloader = class {
        constructor () { return mockDownloaderInstance }
      }
      const mockGetUserRelays = mock.fn(async () => ({
        [nextSiteManifestEvent.pubkey]: { write: new Set(['wss://fetched-relay.com']) }
      }))
      const mockAddressToId = mock.fn(() => appId)
      const mockDeleteStale = mock.fn(async () => {})
      const mockSaveManifest = mock.fn(async () => {})
      const mockGetManifest = mock.fn(async () => ({}))

      const iterator = AppUpdater.updateApp(nextSiteManifestEvent, {
        _AppFileDownloader: MockAppFileDownloader,
        _getUserRelays: mockGetUserRelays,
        _addressObjToAppId: mockAddressToId,
        _deleteStaleFileChunksFromDb: mockDeleteStale,
        _saveSiteManifestToDb: mockSaveManifest,
        _getSiteManifestFromDb: mockGetManifest
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
          if (key === 'session_workspaceByKey_ws1_appById_app1_appKeys') return JSON.stringify(['key1'])
          return null
        })
      }
      const mockSessionStorage = {
        getItem: mock.fn((key) => {
          if (key === 'session_workspaceByKey_ws1_openAppKeys') return JSON.stringify(['key1'])
          return null
        })
      }
      assert.equal(AppUpdater.isAppOpen('app1', { _localStorage: mockLocalStorage, _sessionStorage: mockSessionStorage }), true)
    })

    it('should return false if app is not open', () => {
      const mockLocalStorage = {
        getItem: mock.fn((key) => {
          if (key === 'session_workspaceKeys') return JSON.stringify(['ws1'])
          if (key === 'session_workspaceByKey_ws1_appById_app1_appKeys') return JSON.stringify(['key1'])
          return null
        })
      }
      const mockSessionStorage = {
        getItem: mock.fn((key) => {
          if (key === 'session_workspaceByKey_ws1_openAppKeys') return JSON.stringify(['key2'])
          return null
        })
      }
      assert.equal(AppUpdater.isAppOpen('app1', { _localStorage: mockLocalStorage, _sessionStorage: mockSessionStorage }), false)
    })

    it('should return false if storage is missing', () => {
      assert.equal(AppUpdater.isAppOpen('app1', { _sessionStorage: null, _localStorage: null }), false)
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
      const mockSessionStorage = {
        getItem: mock.fn(() => JSON.stringify([]))
      }
      const mockGetManifest = mock.fn(async () => ({ tags: [['path', 'file1.js', 'hash1']] }))
      const mockDeleteStale = mock.fn(async () => {})

      await AppUpdater.scheduleCleanup(['app1'], {
        _navigator: mockNavigator,
        _localStorage: mockLocalStorage,
        _sessionStorage: mockSessionStorage,
        _getSiteManifestFromDb: mockGetManifest,
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
          if (key.includes('appById_app1_appKeys')) return JSON.stringify(['key1'])
          return null
        })
      }
      const mockSessionStorage = {
        getItem: mock.fn((key) => {
          if (key.includes('openAppKeys')) return JSON.stringify(['key1'])
          return null
        })
      }
      const mockSetTimeout = mock.fn()
      const mockDeleteStale = mock.fn()

      await AppUpdater.scheduleCleanup(['app1'], {
        _navigator: mockNavigator,
        _localStorage: mockLocalStorage,
        _sessionStorage: mockSessionStorage,
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
