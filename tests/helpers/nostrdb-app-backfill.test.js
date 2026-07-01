import { beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

const flushes = []

mock.module('#zones/vault-modal/index.js', {
  namedExports: {
    flushQueuedVaultAcceptedMessages: () => {
      flushes.push(true)
      return Promise.resolve(false)
    }
  }
})

const { base16ToBase62 } = await import('#helpers/base62.js')
const {
  readVaultAcceptedMessageQueue,
  vaultAcceptedMessageQueueInternals
} = await import('../../src/helpers/window-message/browser/vault-accepted-message-queue.js')
const {
  cleanupNostrDbAppForWorkspace,
  isNostrDbAppInstalledForOwner
} = await import('../../src/components/zones/screen/helpers/nostrdb-app-lifecycle.js')
const {
  requestNostrDbAppBackfillForWorkspace,
  requestNostrDbAppBackfillsForWorkspace
} = await import('../../src/components/zones/screen/helpers/nostrdb-app-backfill.js')

const data = new Map()

globalThis.localStorage = {
  getItem: key => data.get(String(key)) ?? null,
  removeItem: key => { data.delete(String(key)) },
  setItem: (key, value) => { data.set(String(key), String(value)) }
}

describe('nostrdb app backfill launcher helper', () => {
  beforeEach(() => {
    flushes.length = 0
    data.clear()
  })

  function storageFor ({
    wsKey = 'ws1',
    userPk,
    defaultUserPk,
    workspaceKeys = [wsKey],
    appKeysByWorkspace = {}
  }) {
    const storage = {
      session_defaultUserPk$: () => defaultUserPk,
      session_workspaceKeys$: () => workspaceKeys
    }
    for (const key of workspaceKeys) {
      storage[`session_workspaceByKey_${key}_userPk$`] = () => userPk
      for (const [appId, appKeys] of Object.entries(appKeysByWorkspace[key] || {})) {
        storage[`session_workspaceByKey_${key}_appById_${appId}_appKeys$`] = () => appKeys
      }
    }
    return storage
  }

  it('queues app backfill requests with hex owner pubkeys', () => {
    const ownerPubkey = 'a'.repeat(64)
    const userPk = base16ToBase62(ownerPubkey)

    assert.equal(requestNostrDbAppBackfillForWorkspace({
      storage: storageFor({ userPk }),
      wsKey: 'ws1',
      appId: 'app-1'
    }), true)

    const queue = readVaultAcceptedMessageQueue()
    assert.deepEqual(queue, [{
      code: 'NOSTRDB_APP_BACKFILL',
      payload: { ownerPubkey, appId: 'app-1' },
      createdAt: queue[0].createdAt,
      lastAttemptAt: 0
    }])
    assert.deepEqual(flushes, [true])
  })

  it('skips the default placeholder user', () => {
    const userPk = base16ToBase62('b'.repeat(64))

    assert.equal(requestNostrDbAppBackfillForWorkspace({
      storage: storageFor({ userPk, defaultUserPk: userPk }),
      wsKey: 'ws1',
      appId: 'app-1'
    }), false)

    assert.deepEqual(readVaultAcceptedMessageQueue(), [])
    assert.deepEqual(flushes, [])
  })

  it('requests every app in a workspace batch', () => {
    const userPk = base16ToBase62('c'.repeat(64))

    assert.equal(requestNostrDbAppBackfillsForWorkspace({
      storage: storageFor({ userPk }),
      wsKey: 'ws1',
      appIds: ['app-1', 'app-2']
    }), 2)

    assert.deepEqual(readVaultAcceptedMessageQueue().map(item => item.payload.appId), ['app-1', 'app-2'])
    assert.deepEqual(flushes, [true, true])
  })

  it('dedupes queued app requests', () => {
    const userPk = base16ToBase62('d'.repeat(64))
    const storage = storageFor({ userPk })

    requestNostrDbAppBackfillForWorkspace({ storage, wsKey: 'ws1', appId: 'app-1' })
    requestNostrDbAppBackfillForWorkspace({ storage, wsKey: 'ws1', appId: 'app-1' })

    assert.equal(readVaultAcceptedMessageQueue().length, 1)
    assert.equal(data.has(vaultAcceptedMessageQueueInternals.KEY), true)
  })

  it('cleans queued backfill and app-owned rows when app becomes absent for owner', async () => {
    const ownerPubkey = 'e'.repeat(64)
    const userPk = base16ToBase62(ownerPubkey)
    const storage = storageFor({
      userPk,
      appKeysByWorkspace: { ws1: { 'app-1': ['key-1'] } }
    })
    const deletes = []

    requestNostrDbAppBackfillForWorkspace({ storage, wsKey: 'ws1', appId: 'app-1' })

    assert.equal(await cleanupNostrDbAppForWorkspace({
      storage,
      wsKey: 'ws1',
      appId: 'app-1',
      excludeWorkspaceKeys: ['ws1'],
      getNostrDb: owner => ({
        async deleteEventsByApp (appId) {
          deletes.push({ owner, appId })
          return 1
        }
      }),
      getSiteManifestFromDb: async () => null
    }), true)

    assert.deepEqual(readVaultAcceptedMessageQueue(), [])
    assert.deepEqual(deletes, [{ owner: ownerPubkey, appId: 'app-1' }])
  })

  it('does not clean app data when another instance remains for the same owner', async () => {
    const ownerPubkey = 'f'.repeat(64)
    const userPk = base16ToBase62(ownerPubkey)
    const storage = storageFor({
      userPk,
      appKeysByWorkspace: { ws1: { 'app-1': ['key-1', 'key-2'] } }
    })
    const deletes = []

    requestNostrDbAppBackfillForWorkspace({ storage, wsKey: 'ws1', appId: 'app-1' })

    assert.equal(await cleanupNostrDbAppForWorkspace({
      storage,
      wsKey: 'ws1',
      appId: 'app-1',
      excludeAppKeys: ['key-1'],
      getNostrDb: () => ({
        async deleteEventsByApp (appId) {
          deletes.push(appId)
          return 1
        }
      }),
      getSiteManifestFromDb: async () => null
    }), false)

    assert.equal(readVaultAcceptedMessageQueue().length, 1)
    assert.deepEqual(deletes, [])
  })

  it('does not clean app data when the same owner still has the app in another workspace', async () => {
    const ownerPubkey = '1'.repeat(64)
    const userPk = base16ToBase62(ownerPubkey)
    const storage = storageFor({
      userPk,
      workspaceKeys: ['ws1', 'ws2'],
      appKeysByWorkspace: {
        ws1: { 'app-1': ['key-1'] },
        ws2: { 'app-1': ['key-2'] }
      }
    })

    assert.equal(isNostrDbAppInstalledForOwner({
      storage,
      ownerPubkey,
      appId: 'app-1',
      excludeWorkspaceKeys: ['ws1']
    }), true)
    assert.equal(await cleanupNostrDbAppForWorkspace({
      storage,
      wsKey: 'ws1',
      appId: 'app-1',
      excludeWorkspaceKeys: ['ws1'],
      getNostrDb: () => {
        throw new Error('should not open db')
      },
      getSiteManifestFromDb: async () => null
    }), false)
  })

  it('keeps owner app data when that owner recently opened the app as a single napp', async () => {
    const ownerPubkey = '3'.repeat(64)
    const userPk = base16ToBase62(ownerPubkey)
    const now = 100_000
    const storage = storageFor({
      userPk,
      appKeysByWorkspace: { ws1: { 'app-1': ['key-1'] } }
    })
    const deletes = []

    requestNostrDbAppBackfillForWorkspace({ storage, wsKey: 'ws1', appId: 'app-1' })

    assert.equal(await cleanupNostrDbAppForWorkspace({
      storage,
      wsKey: 'ws1',
      appId: 'app-1',
      excludeWorkspaceKeys: ['ws1'],
      getSiteManifestFromDb: async () => ({
        meta: { singleNappOpenedAtByOwner: { [ownerPubkey]: now } }
      }),
      getNostrDb: () => ({
        async deleteEventsByApp (appId) {
          deletes.push(appId)
          return 1
        }
      }),
      now
    }), false)

    assert.equal(readVaultAcceptedMessageQueue().length, 1)
    assert.deepEqual(deletes, [])
  })

  it('does not let another owner single-napp usage preserve this owner app data', async () => {
    const ownerPubkey = '4'.repeat(64)
    const otherOwnerPubkey = '5'.repeat(64)
    const userPk = base16ToBase62(ownerPubkey)
    const now = 100_000
    const storage = storageFor({
      userPk,
      appKeysByWorkspace: { ws1: { 'app-1': ['key-1'] } }
    })
    const deletes = []

    assert.equal(await cleanupNostrDbAppForWorkspace({
      storage,
      wsKey: 'ws1',
      appId: 'app-1',
      excludeWorkspaceKeys: ['ws1'],
      getSiteManifestFromDb: async () => ({
        meta: { singleNappOpenedAtByOwner: { [otherOwnerPubkey]: now } }
      }),
      getNostrDb: owner => ({
        async deleteEventsByApp (appId) {
          deletes.push({ owner, appId })
          return 1
        }
      }),
      now
    }), true)

    assert.deepEqual(deletes, [{ owner: ownerPubkey, appId: 'app-1' }])
  })

  it('removes the owner single-napp entry when deleting owner app data', async () => {
    const ownerPubkey = '6'.repeat(64)
    const otherOwnerPubkey = '7'.repeat(64)
    const userPk = base16ToBase62(ownerPubkey)
    const manifest = {
      meta: {
        singleNappOpenedAtByOwner: {
          [ownerPubkey]: 1,
          [otherOwnerPubkey]: 2
        }
      }
    }
    const storage = storageFor({
      userPk,
      appKeysByWorkspace: { ws1: { 'app-1': ['key-1'] } }
    })
    const saved = []

    assert.equal(await cleanupNostrDbAppForWorkspace({
      storage,
      wsKey: 'ws1',
      appId: 'app-1',
      excludeWorkspaceKeys: ['ws1'],
      getSiteManifestFromDb: async () => manifest,
      saveSiteManifestToDb: async (event, metadata) => saved.push({ event, metadata }),
      getNostrDb: () => ({
        async deleteEventsByApp () {
          return 1
        }
      })
    }), true)

    assert.deepEqual(saved, [{
      event: manifest,
      metadata: {
        singleNappOpenedAtByOwner: { [otherOwnerPubkey]: 2 }
      }
    }])
  })

  it('treats removed owner workspaces as absent during cleanup', async () => {
    const ownerPubkey = '2'.repeat(64)
    const userPk = base16ToBase62(ownerPubkey)
    const storage = storageFor({
      userPk,
      workspaceKeys: ['ws1', 'ws2'],
      appKeysByWorkspace: {
        ws1: { 'app-1': ['key-1'] },
        ws2: { 'app-1': ['key-2'] }
      }
    })
    const deletes = []

    assert.equal(await cleanupNostrDbAppForWorkspace({
      storage,
      wsKey: 'ws1',
      appId: 'app-1',
      excludeWorkspaceKeys: ['ws1', 'ws2'],
      getNostrDb: owner => ({
        async deleteEventsByApp (appId) {
          deletes.push({ owner, appId })
          return 2
        }
      }),
      getSiteManifestFromDb: async () => null
    }), true)
    assert.deepEqual(deletes, [{ owner: ownerPubkey, appId: 'app-1' }])
  })
})
