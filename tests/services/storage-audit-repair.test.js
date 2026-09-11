import assert from 'node:assert/strict'
import { before, describe, it, mock } from 'node:test'

mock.module('#f', {
  namedExports: {
    setWebStorageItem: (area, key, value) => {
      if (value === undefined) area.removeItem(key)
      else area.setItem(key, JSON.stringify(value))
    }
  }
})

mock.module('#services/app-file-manager/index.js', {
  defaultExport: class {
    static async clearCachedFilesById () {}
  }
})
mock.module('#services/app-updater/index.js', {
  defaultExport: class {
    static clearCachedAppMetadata () {}
    static removeSubdomainMappingsForApp () {}
  }
})
mock.module('#helpers/nostrdb-app-cleanup.js', {
  namedExports: {
    cleanupNostrDbAppForOwner: async () => true
  }
})
mock.module('#components/zones/screen/helpers/nostrdb-app-lifecycle.js', {
  namedExports: {
    hasAnyRecentSingleNappOpen: async () => false
  }
})
mock.module('#services/idb/browser/queries/permission.js', {
  namedExports: {
    deleteAllPermissionsForApp: async () => {}
  }
})
mock.module('#services/idb/nostrdb/index.js', {
  namedExports: {
    deleteNostrDb: async () => true
  }
})

let applyStorageRepairPlan

before(async () => {
  ({ applyStorageRepairPlan } = await import('#services/storage-audit/repair.js'))
})

function storageMock (entries = {}) {
  const data = new Map(Object.entries(entries))
  return {
    get length () { return data.size },
    key (index) { return [...data.keys()][index] ?? null },
    getItem (key) { return data.has(key) ? data.get(key) : null },
    setItem (key, value) { data.set(key, String(value)) },
    removeItem (key) { data.delete(key) },
    _data: data
  }
}

describe('storage repair plan', () => {
  it('writes repaired widget records without dropping visual pins or adding flags to legacy records', async () => {
    const local = storageMock()
    const legacy = { appId: 'app', wsKey: 'ws', row: 0, col: 0, desired: { w: 1, h: 1 }, pinnedRoute: '/route' }
    const records = { legacy, pinned: { ...legacy, isPinned: true } }
    await applyStorageRepairPlan({ local: { local_widgets: records } }, { localStorageArea: local, sessionStorageArea: storageMock() })
    assert.deepEqual(JSON.parse(local.getItem('local_widgets')), records)
  })

  it('applies local/session writes and the explicit cleanup actions', async () => {
    const ownerPubkey = 'ab'.repeat(32)
    const local = storageMock({
      '44billion:nostrdb-quotas:v1': JSON.stringify({ cacheBytes: 1024 }),
      session_to_remove: JSON.stringify({ broken: true }),
      session_accountByUserPk_user_isReadOnly: JSON.stringify(true),
      session_accountByUserPk_user_isLocked: JSON.stringify(false),
      session_accountByUserPk_user_profile: JSON.stringify({}),
      session_accountByUserPk_user_relays: JSON.stringify({}),
      session_workspaceByKey_ws_userPk: JSON.stringify('user'),
      session_subdomainByUserAndApp_user_app: JSON.stringify('7'),
      session_subdomainToApp_7: JSON.stringify({ userPk: 'user', appId: 'app' })
    })
    const session = storageMock({
      session_appByKey_key_visibility: JSON.stringify('open')
    })

    await applyStorageRepairPlan({
      version: 1,
      issues: [],
      local: { session_to_remove: null },
      session: {},
      removeWorkspaces: [{ wsKey: 'ws', userPk: 'user', ownerPubkey }],
      removeAppInstances: [{ wsKey: 'ws', appId: 'app', appKey: 'key' }],
      removeApps: [{ appId: 'app', ownerPubkey }],
      removeAccounts: [{ userPk: 'user', ownerPubkey }],
      removeNostrDbOwners: [ownerPubkey],
      releaseSubdomains: [{ userPk: 'user', appId: 'app', subdomain: '7' }]
    }, { localStorageArea: local, sessionStorageArea: session })

    assert.equal(local.getItem('session_to_remove'), null)
    assert.deepEqual(JSON.parse(local.getItem('44billion:nostrdb-quotas:v1')), { cacheBytes: 1024 })
    assert.equal(local.getItem('session_accountByUserPk_user_profile'), null)
    assert.equal(session.getItem('session_appByKey_key_visibility'), null)
    assert.equal(local.getItem('session_workspaceByKey_ws_userPk'), null)
    assert.equal(local.getItem('session_subdomainByUserAndApp_user_app'), null)
    assert.equal(local.getItem('session_subdomainToApp_7'), null)
    assert.deepEqual(JSON.parse(local.getItem('local_subdomainLifecycle')).pending, ['7'])
  })
})

it('does not retire a replacement assignment from a stale audit plan', async () => {
  const local = storageMock({
    session_subdomainByUserAndApp_user_app: JSON.stringify('7'),
    session_subdomainToApp_7: JSON.stringify({ userPk: 'user', appId: 'app' }),
    local_subdomainLifecycle: JSON.stringify({ version: 1, pending: [], assignments: { 7: 'new' } })
  })
  await applyStorageRepairPlan({
    local: {}, session: {},
    subdomainSnapshot: { local_subdomainLifecycle: { version: 1, pending: [], assignments: { 7: 'old' } } },
    releaseSubdomains: [{ userPk: 'user', appId: 'app', subdomain: '7' }]
  }, { localStorageArea: local, sessionStorageArea: storageMock({}) })
  assert.equal(local.getItem('session_subdomainByUserAndApp_user_app'), JSON.stringify('7'))
  assert.deepEqual(JSON.parse(local.getItem('local_subdomainLifecycle')).pending, [])
})
