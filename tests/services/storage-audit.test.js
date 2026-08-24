import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  auditPersistedState,
  hasStorageRepairActions,
  normalizeCoreListsInStorage,
  normalizeOpenAppKeyList,
  normalizeOpenAppKeysInStorage,
  normalizePersistedListsInStorage
} from '#services/storage-audit/audit.js'

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

function encode (entries) {
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]))
}

function validState (overrides = {}) {
  return {
    local: storageMock(encode({
      storage_version: '2',
      config_locale: 'en',
      config_isSingleWindow: false,
      config_appUpdateMode: 'always',
      config_vaultUrl: 'https://vault.example',
      session_defaultUserPk: 'user',
      session_accountUserPks: ['user'],
      session_workspaceKeys: ['ws1'],
      session_openWorkspaceKeys: ['ws1'],
      session_workspaceByKey_ws1_userPk: 'user',
      session_workspaceByKey_ws1_pinnedAppIds: ['app1'],
      session_workspaceByKey_ws1_unpinnedAppIds: [],
      session_workspaceByKey_ws1_unpinnedCoreAppIdsObj: {},
      session_workspaceByKey_ws1_appById_app1_appKeys: ['key1'],
      session_appByKey_key1_id: 'app1',
      session_appByKey_key1_route: '',
      session_accountByUserPk_user_isReadOnly: true,
      session_accountByUserPk_user_isLocked: false,
      session_accountByUserPk_user_profile: { name: 'User' },
      session_accountByUserPk_user_relays: { meta: { events: [] } },
      ...overrides.local
    })),
    session: storageMock(encode({
      session_workspaceByKey_ws1_openAppKeys: [],
      session_appByKey_key1_visibility: 'closed',
      ...overrides.session
    }))
  }
}

describe('storage audit', () => {
  it('reports a valid state with no repair actions', () => {
    const state = validState()
    const result = auditPersistedState(state.local, state.session)

    assert.equal(result.ok, true)
    assert.equal(hasStorageRepairActions(result.plan), false)
  })

  it('treats missing per-tab visibility as closed', () => {
    const state = validState({ session: {} })
    const result = auditPersistedState(state.local, state.session)

    assert.equal(result.ok, true)
    assert.equal(hasStorageRepairActions(result.plan), false)
  })

  it('removes a dangling app instance', () => {
    const state = validState({
      local: {
        session_workspaceByKey_ws1_appById_app1_appKeys: ['key1', 'key2']
      }
    })
    const result = auditPersistedState(state.local, state.session)

    assert.equal(result.ok, false)
    assert.deepEqual(result.plan.removeAppInstances, [{ wsKey: 'ws1', appId: 'app1', appKey: 'key2' }])
    assert.deepEqual(result.plan.local['session_workspaceByKey_ws1_appById_app1_appKeys'], ['key1'])
    assert.equal(result.plan.local['session_appByKey_key2_id'], null)
  })

  it('removes an app that has no valid instances', () => {
    const state = validState({
      local: {
        session_workspaceByKey_ws1_appById_app1_appKeys: []
      }
    })
    const result = auditPersistedState(state.local, state.session)

    assert.equal(result.ok, false)
    assert.deepEqual(result.plan.removeApps, [{ appId: 'app1', ownerPubkey: '' }])
    assert.equal(result.plan.local['session_workspaceByKey_ws1_pinnedAppIds'].length, 0)
  })

  it('removes a workspace with no valid owner', () => {
    const state = validState({
      local: {
        session_workspaceByKey_ws1_userPk: ''
      }
    })
    const result = auditPersistedState(state.local, state.session)

    assert.equal(result.ok, false)
    assert.deepEqual(result.plan.removeWorkspaces, [{ wsKey: 'ws1', userPk: null, ownerPubkey: '' }])
  })

  it('detects dangling open workspace keys without scheduling a silent write', () => {
    const state = validState({
      local: {
        session_openWorkspaceKeys: ['ws1', 'missing']
      }
    })
    const warns = []
    const originalWarn = console.warn
    console.warn = (...args) => warns.push(args.join(' '))
    try {
      const result = auditPersistedState(state.local, state.session)

      assert.equal(result.ok, true)
      assert.equal(result.plan.local.session_openWorkspaceKeys, undefined)
      assert.equal(warns.length, 1)
      assert.match(warns[0], /session_openWorkspaceKeys would change/)
      assert.match(warns[0], /missing/)
    } finally {
      console.warn = originalWarn
    }
  })

  it('detects duplicate workspace keys without scheduling a silent write', () => {
    const state = validState({
      local: {
        session_workspaceKeys: ['ws1', 'ws1']
      }
    })
    const warns = []
    const originalWarn = console.warn
    console.warn = (...args) => warns.push(args.join(' '))
    try {
      const result = auditPersistedState(state.local, state.session)

      assert.equal(result.ok, true)
      assert.equal(result.plan.local.session_workspaceKeys, undefined)
      assert.equal(warns.length, 1)
      assert.match(warns[0], /session_workspaceKeys would change/)
    } finally {
      console.warn = originalWarn
    }
  })

  it('detects open app keys that need normalization without scheduling a silent write', () => {
    const state = validState({
      session: {
        session_workspaceByKey_ws1_openAppKeys: ['key1', 'key1', 'missing']
      }
    })
    const warns = []
    const originalWarn = console.warn
    console.warn = (...args) => warns.push(args.join(' '))
    try {
      const result = auditPersistedState(state.local, state.session)

      assert.equal(result.ok, true)
      assert.equal(result.plan.session.session_workspaceByKey_ws1_openAppKeys, undefined)
      assert.equal(warns.length, 1)
      assert.match(warns[0], /openAppKeys for workspace ws1 would change/)
      assert.match(warns[0], /missing/)
    } finally {
      console.warn = originalWarn
    }
  })

  it('normalizeOpenAppKeyList dedupes and keeps only open referenced keys', () => {
    const local = new Map([
      ['session_appByKey_key1_id', 'app1'],
      ['session_appByKey_key2_id', 'app1']
    ])
    const session = new Map([
      ['session_appByKey_key1_visibility', 'open'],
      ['session_appByKey_key2_visibility', 'minimized']
    ])

    assert.deepEqual(
      normalizeOpenAppKeyList(['key1', 'key2', 'key1', 'ghost'], {
        referencedAppKeys: new Set(['key1', 'key2']),
        getLocal: key => local.get(key),
        getSession: key => session.get(key)
      }),
      ['key1']
    )
  })

  it('normalizes openAppKeys directly in sessionStorage and logs', () => {
    const local = storageMock(encode({
      session_workspaceKeys: ['ws1'],
      session_workspaceByKey_ws1_pinnedAppIds: ['app1'],
      session_workspaceByKey_ws1_unpinnedAppIds: [],
      session_workspaceByKey_ws1_appById_app1_appKeys: ['key1'],
      session_appByKey_key1_id: 'app1'
    }))
    const session = storageMock(encode({
      session_workspaceByKey_ws1_openAppKeys: ['key1', 'key1', 'ghost'],
      session_appByKey_key1_visibility: 'open'
    }))
    const warns = []
    const originalWarn = console.warn
    console.warn = (...args) => warns.push(args.join(' '))
    try {
      const result = normalizeOpenAppKeysInStorage({
        localStorageArea: local,
        sessionStorageArea: session
      })

      assert.equal(result.changed, 1)
      assert.deepEqual(JSON.parse(session.getItem('session_workspaceByKey_ws1_openAppKeys')), ['key1'])
      assert.equal(warns.length, 1)
      assert.match(warns[0], /Normalized openAppKeys for workspace ws1/)
      assert.match(warns[0], /ghost/)
    } finally {
      console.warn = originalWarn
    }
  })

  it('normalizeOpenAppKeysInStorage skips missing and invalid values silently', () => {
    const local = storageMock(encode({
      session_workspaceKeys: ['ws1']
    }))
    const session = storageMock({
      session_workspaceByKey_ws1_openAppKeys: '{not json'
    })
    const warns = []
    const originalWarn = console.warn
    console.warn = (...args) => warns.push(args.join(' '))
    try {
      const result = normalizeOpenAppKeysInStorage({
        localStorageArea: local,
        sessionStorageArea: session
      })

      assert.equal(result.changed, 0)
      assert.equal(session.getItem('session_workspaceByKey_ws1_openAppKeys'), '{not json')
      assert.deepEqual(warns, [])
    } finally {
      console.warn = originalWarn
    }
  })

  it('normalizes core localStorage lists and logs each change', () => {
    const local = storageMock(encode({
      session_workspaceKeys: ['ws1', 'ws1'],
      session_accountUserPks: ['user', 'user'],
      session_openWorkspaceKeys: ['ws1', 'ghost']
    }))
    const warns = []
    const originalWarn = console.warn
    console.warn = (...args) => warns.push(args.join(' '))
    try {
      const result = normalizeCoreListsInStorage({ localStorageArea: local })

      assert.equal(result.changed, 3)
      assert.deepEqual(JSON.parse(local.getItem('session_workspaceKeys')), ['ws1'])
      assert.deepEqual(JSON.parse(local.getItem('session_accountUserPks')), ['user'])
      assert.deepEqual(JSON.parse(local.getItem('session_openWorkspaceKeys')), ['ws1'])
      assert.equal(warns.length, 3)
      assert.match(warns[0], /Normalized session_workspaceKeys/)
      assert.match(warns[1], /Normalized session_accountUserPks/)
      assert.match(warns[2], /Normalized session_openWorkspaceKeys/)
      assert.match(warns[2], /ghost/)
    } finally {
      console.warn = originalWarn
    }
  })

  it('normalizeCoreListsInStorage skips missing and invalid values silently', () => {
    const local = storageMock({
      session_workspaceKeys: '{not json',
      session_accountUserPks: JSON.stringify('not-an-array')
    })
    const warns = []
    const originalWarn = console.warn
    console.warn = (...args) => warns.push(args.join(' '))
    try {
      const result = normalizeCoreListsInStorage({ localStorageArea: local })

      assert.equal(result.changed, 0)
      assert.deepEqual(warns, [])
      assert.equal(local.getItem('session_workspaceKeys'), '{not json')
      assert.equal(local.getItem('session_accountUserPks'), JSON.stringify('not-an-array'))
    } finally {
      console.warn = originalWarn
    }
  })

  it('normalizePersistedListsInStorage combines core and openAppKeys changes', () => {
    const local = storageMock(encode({
      session_workspaceKeys: ['ws1', 'ws1'],
      session_workspaceByKey_ws1_pinnedAppIds: ['app1'],
      session_workspaceByKey_ws1_unpinnedAppIds: [],
      session_workspaceByKey_ws1_appById_app1_appKeys: ['key1'],
      session_appByKey_key1_id: 'app1'
    }))
    const session = storageMock(encode({
      session_workspaceByKey_ws1_openAppKeys: ['key1', 'key1'],
      session_appByKey_key1_visibility: 'open'
    }))
    const warns = []
    const originalWarn = console.warn
    console.warn = (...args) => warns.push(args.join(' '))
    try {
      const result = normalizePersistedListsInStorage({
        localStorageArea: local,
        sessionStorageArea: session
      })

      assert.equal(result.changed, 2)
      assert.deepEqual(result.core.map(entry => entry.key), ['session_workspaceKeys'])
      assert.deepEqual(JSON.parse(local.getItem('session_workspaceKeys')), ['ws1'])
      assert.deepEqual(JSON.parse(session.getItem('session_workspaceByKey_ws1_openAppKeys')), ['key1'])
      assert.equal(warns.length, 2)
    } finally {
      console.warn = originalWarn
    }
  })

  it('keeps invalid_array writes as the only actionable openAppKeys path', () => {
    const state = validState({
      session: {
        session_workspaceByKey_ws1_openAppKeys: 'not-an-array'
      }
    })
    const result = auditPersistedState(state.local, state.session)

    assert.equal(result.ok, false)
    assert.deepEqual(result.plan.session.session_workspaceByKey_ws1_openAppKeys, [])
    assert.equal(result.issues.some(issue => issue.code === 'invalid_array'), true)
  })

  it('repairs a one-sided subdomain mapping', () => {
    const state = validState({
      local: {
        session_subdomainToApp_7: { userPk: 'user', appId: 'app1' }
      }
    })
    const result = auditPersistedState(state.local, state.session)

    assert.equal(result.ok, false)
    assert.deepEqual(result.plan.releaseSubdomains, [{ userPk: 'user', appId: 'app1', subdomain: '7' }])
  })

  it('removes orphan known keys and preserves unknown keys', () => {
    const state = validState({
      local: {
        session_appById_orphan_name: 'Orphan',
        custom_unknown_key: 'keep'
      }
    })
    const result = auditPersistedState(state.local, state.session)

    assert.equal(result.ok, false)
    assert.equal(result.plan.local.session_appById_orphan_name, null)
    assert.equal(result.plan.local.custom_unknown_key, undefined)
  })
})
