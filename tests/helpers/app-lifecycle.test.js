import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

mock.module('#services/idb/browser/queries/site-manifest.js', {
  namedExports: {
    getSiteManifestFromDb: async () => null,
    normalizeSingleNappOpenedAtByOwner: value => value ?? {},
    saveSiteManifestToDb: async () => {}
  }
})
mock.module('#helpers/window-message/browser/vault-accepted-message-queue.js', {
  namedExports: {
    removeVaultAcceptedMessage: () => {}
  }
})
const {
  clearAppDataAfterRemoval,
  countAppInstances,
  defaultClearAppFiles,
  removeAppFromWorkspace,
  removeAppInstance,
  uninstallAppFromWorkspace
} = await import('../../src/components/zones/screen/helpers/app-lifecycle.js')

function signalStorage (entries = {}) {
  const data = new Map(Object.entries(entries))
  return new Proxy({}, {
    get (_target, key) {
      if (typeof key !== 'string' || !key.endsWith('$')) return undefined
      const storageKey = key.slice(0, -1)
      return (...args) => {
        if (args.length === 0) return data.get(storageKey)
        const value = args[0]
        const next = typeof value === 'function'
          ? value(data.get(storageKey))
          : value
        if (next === undefined) data.delete(storageKey)
        else data.set(storageKey, next)
        return next
      }
    }
  })
}

function baseAppStorage (overrides = {}) {
  return {
    session_workspaceKeys: ['ws1', 'ws2'],
    session_workspaceByKey_ws1_userPk: 'user-a',
    session_workspaceByKey_ws2_userPk: 'user-b',
    session_workspaceByKey_ws1_appById_app_appKeys: ['a', 'b'],
    session_workspaceByKey_ws2_appById_app_appKeys: [],
    session_workspaceByKey_ws1_pinnedAppIds: ['app'],
    session_workspaceByKey_ws1_unpinnedAppIds: [],
    session_appById_app_name: 'App',
    session_appById_app_description: 'Desc',
    session_appById_app_icon: { url: 'https://example.test/icon.png' },
    session_appById_app_relayHints: [],
    'session_subdomainByUserAndApp_user-a_app': '7',
    ...overrides
  }
}

function baseTabStorage (overrides = {}) {
  return {
    session_workspaceByKey_ws1_openAppKeys: ['a', 'b'],
    session_appByKey_a_visibility: 'open',
    session_appByKey_b_visibility: 'open',
    ...overrides
  }
}

describe('app lifecycle helper', () => {
  it('removes a single instance without removing the app lists', () => {
    const storage = signalStorage(baseAppStorage())
    const tabStorage = signalStorage(baseTabStorage())

    const result = removeAppInstance({
      storage,
      tabStorage,
      wsKey: 'ws1',
      appKey: 'a',
      appId: 'app',
      userPk: 'user-a'
    })

    assert.equal(result.remainingInWorkspace, 1)
    assert.deepEqual(storage.session_workspaceByKey_ws1_appById_app_appKeys$(), ['b'])
    assert.deepEqual(storage.session_workspaceByKey_ws1_pinnedAppIds$(), ['app'])
    assert.deepEqual(tabStorage.session_workspaceByKey_ws1_openAppKeys$(), ['b'])
    assert.equal(tabStorage.session_appByKey_a_visibility$(), undefined)
  })

  it('removes instance and lists without clearing metadata', () => {
    const storage = signalStorage(baseAppStorage({
      session_workspaceByKey_ws1_appById_app_appKeys: ['a']
    }))
    const tabStorage = signalStorage(baseTabStorage({
      session_workspaceByKey_ws1_openAppKeys: ['a'],
      session_appByKey_b_visibility: undefined
    }))

    const result = removeAppFromWorkspace({
      storage,
      tabStorage,
      wsKey: 'ws1',
      appKey: 'a',
      appId: 'app',
      userPk: 'user-a'
    })

    assert.equal(result.remainingInWorkspace, 0)
    assert.equal(result.hasOtherAnyInstances, false)
    assert.equal(storage.session_workspaceByKey_ws1_appById_app_appKeys$(), undefined)
    assert.deepEqual(storage.session_workspaceByKey_ws1_pinnedAppIds$(), [])
    assert.deepEqual(storage.session_workspaceByKey_ws1_unpinnedAppIds$(), [])
    assert.equal(storage.session_appById_app_name$(), 'App')
  })

  it('uninstalls through the shared lifecycle helper', async () => {
    const storage = signalStorage(baseAppStorage({
      session_workspaceByKey_ws1_appById_app_appKeys: ['a']
    }))
    const tabStorage = signalStorage(baseTabStorage({
      session_workspaceByKey_ws1_openAppKeys: ['a']
    }))
    const calls = {
      cleanup: [],
      ask: [],
      release: [],
      files: []
    }

    const result = await uninstallAppFromWorkspace({
      storage,
      tabStorage,
      wsKey: 'ws1',
      appKey: 'a',
      appId: 'app',
      userPk: 'user-a',
      appSubdomain: '7',
      _cleanupNostrDb: async args => { calls.cleanup.push(args) },
      _askAppToClearData: async appSubdomain => { calls.ask.push(appSubdomain) },
      _hasRecentSingleNappOpenForOwner: async () => false,
      _hasAnyRecentSingleNappOpen: async () => false,
      _clearAppFiles: async appId => { calls.files.push(appId) },
      _releaseAppSubdomain: (...args) => { calls.release.push(args) },
      _removeWidgetsForApp: () => {},
      _removeSelectionsForApp: () => {},
      _base62ToBase16: () => 'a'.repeat(64)
    })

    assert.equal(result.remainingInWorkspace, 0)
    assert.deepEqual(storage.session_workspaceByKey_ws1_appById_app_appKeys$(), undefined)
    assert.equal(storage.session_appById_app_name$(), undefined)
    assert.equal(calls.cleanup.length, 1)
    assert.equal(calls.cleanup[0].storage, storage)
    assert.equal(calls.cleanup[0].wsKey, 'ws1')
    assert.equal(calls.cleanup[0].appId, 'app')
    assert.deepEqual(calls.cleanup[0].excludeWorkspaceKeys, ['ws1'])
    assert.deepEqual(calls.ask, ['7'])
    assert.equal(calls.release.length, 1)
    assert.deepEqual(calls.files, ['app'])
  })

  it('keeps metadata and files when another user still has the app', async () => {
    const storage = signalStorage(baseAppStorage({
      session_workspaceByKey_ws1_appById_app_appKeys: ['a'],
      session_workspaceByKey_ws2_appById_app_appKeys: ['b']
    }))
    const tabStorage = signalStorage(baseTabStorage({
      session_workspaceByKey_ws1_openAppKeys: ['a'],
      session_appByKey_b_visibility: undefined
    }))
    const calls = { cleanup: [], clear: [], release: [], files: [] }

    const removed = removeAppFromWorkspace({
      storage,
      tabStorage,
      wsKey: 'ws1',
      appKey: 'a',
      appId: 'app',
      userPk: 'user-a'
    })

    assert.equal(removed.hasOtherAnyInstances, true)
    assert.equal(storage.session_appById_app_name$(), 'App')
    assert.deepEqual(storage.session_workspaceByKey_ws1_pinnedAppIds$(), [])

    await clearAppDataAfterRemoval({
      storage,
      wsKey: 'ws1',
      appId: 'app',
      userPk: 'user-a',
      appSubdomain: removed.appSubdomain,
      _cleanupNostrDb: async args => { calls.cleanup.push(args) },
      _askAppToClearData: async appSubdomain => { calls.clear.push(appSubdomain) },
      _hasRecentSingleNappOpenForOwner: async () => false,
      _hasAnyRecentSingleNappOpen: async () => false,
      _clearAppFiles: async appId => { calls.files.push(appId) },
      _releaseAppSubdomain: (...args) => { calls.release.push(args) },
      _base62ToBase16: () => 'a'.repeat(64)
    })

    assert.equal(calls.cleanup.length, 1)
    assert.deepEqual(calls.clear, ['7'])
    assert.equal(calls.release.length, 1)
    assert.deepEqual(calls.files, [])
    assert.equal(storage.session_appById_app_name$(), 'App')
  })

  it('does not clear another same-user workspace data', async () => {
    const storage = signalStorage(baseAppStorage({
      session_workspaceByKey_ws1_appById_app_appKeys: ['a'],
      session_workspaceByKey_ws2_appById_app_appKeys: ['b'],
      session_workspaceByKey_ws2_userPk: 'user-a'
    }))
    const tabStorage = signalStorage(baseTabStorage({
      session_workspaceByKey_ws1_openAppKeys: ['a'],
      session_appByKey_b_visibility: undefined
    }))
    const calls = { clear: [], release: [], files: [] }

    const removed = removeAppFromWorkspace({
      storage,
      tabStorage,
      wsKey: 'ws1',
      appKey: 'a',
      appId: 'app',
      userPk: 'user-a'
    })

    assert.equal(removed.hasOtherSameUserInstances, true)
    await clearAppDataAfterRemoval({
      storage,
      wsKey: 'ws1',
      appId: 'app',
      userPk: 'user-a',
      appSubdomain: removed.appSubdomain,
      _cleanupNostrDb: async () => { throw new Error('should not clean same-user app') },
      _askAppToClearData: async appSubdomain => { calls.clear.push(appSubdomain) },
      _hasRecentSingleNappOpenForOwner: async () => false,
      _hasAnyRecentSingleNappOpen: async () => false,
      _clearAppFiles: async appId => { calls.files.push(appId) },
      _releaseAppSubdomain: (...args) => { calls.release.push(args) },
      _base62ToBase16: () => 'a'.repeat(64)
    })

    assert.deepEqual(calls.clear, [])
    assert.deepEqual(calls.release, [])
    assert.deepEqual(calls.files, [])
  })

  it('preserves files when a recent single napp is retained', async () => {
    const storage = signalStorage(baseAppStorage({
      session_workspaceByKey_ws1_appById_app_appKeys: ['a']
    }))
    const calls = { files: [], clear: [] }

    await clearAppDataAfterRemoval({
      storage,
      wsKey: 'ws1',
      appId: 'app',
      userPk: 'user-a',
      appSubdomain: '7',
      _cleanupNostrDb: async () => {},
      _askAppToClearData: async appSubdomain => { calls.clear.push(appSubdomain) },
      _hasRecentSingleNappOpenForOwner: async () => true,
      _hasAnyRecentSingleNappOpen: async () => true,
      _clearAppFiles: async appId => { calls.files.push(appId) },
      _releaseAppSubdomain: () => {},
      _base62ToBase16: () => 'a'.repeat(64)
    })

    assert.deepEqual(calls.clear, [])
    assert.deepEqual(calls.files, [])
  })

  it('keeps the static class binding when clearing cached files', async () => {
    class MockAppFileManager {
      static #calls = []
      static async clearCachedFilesById (appId) {
        MockAppFileManager.#calls.push(appId)
        return appId
      }

      static get calls () {
        return MockAppFileManager.#calls
      }
    }

    await defaultClearAppFiles('app', {
      _loadAppFileManager: async () => ({ default: MockAppFileManager })
    })

    assert.deepEqual(MockAppFileManager.calls, ['app'])
  })

  it('releases the current user subdomain when uninstalling', async () => {
    const storage = signalStorage(baseAppStorage({
      session_workspaceByKey_ws1_appById_app_appKeys: ['a'],
      session_subdomainNextId: 10,
      session_subdomainToApp_7: { userPk: 'user-a', appId: 'app' }
    }))
    const tabStorage = signalStorage(baseTabStorage({
      session_workspaceByKey_ws1_openAppKeys: ['a']
    }))

    await uninstallAppFromWorkspace({
      storage,
      tabStorage,
      wsKey: 'ws1',
      appKey: 'a',
      appId: 'app',
      userPk: 'user-a',
      appSubdomain: '7',
      _cleanupNostrDb: async () => {},
      _askAppToClearData: async () => {},
      _hasRecentSingleNappOpenForOwner: async () => false,
      _hasAnyRecentSingleNappOpen: async () => false,
      _clearAppFiles: async () => {},
      _removeWidgetsForApp: () => {},
      _removeSelectionsForApp: () => {},
      _base62ToBase16: () => 'a'.repeat(64)
    })

    assert.equal(storage['session_subdomainByUserAndApp_user-a_app$'](), undefined)
    assert.equal(storage['session_subdomainToApp_7$'](), undefined)
    assert.deepEqual(storage.session_subdomainFreeIds$(), ['7'])
  })

  it('counts same-user instances separately from other users', () => {
    const storage = signalStorage(baseAppStorage({
      session_workspaceByKey_ws2_userPk: 'user-a'
    }))

    const counts = countAppInstances({ storage, appId: 'app', userPk: 'user-a' })

    assert.equal(counts.hasOtherAnyInstances, true)
    assert.equal(counts.hasOtherSameUserInstances, true)
  })
})
