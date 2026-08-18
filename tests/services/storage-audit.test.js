import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  auditPersistedState,
  hasStorageRepairActions
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

  it('normalizes dangling open workspace keys', () => {
    const state = validState({
      local: {
        session_openWorkspaceKeys: ['ws1', 'missing']
      }
    })
    const result = auditPersistedState(state.local, state.session)

    assert.equal(result.ok, false)
    assert.deepEqual(result.plan.local.session_openWorkspaceKeys, ['ws1'])
  })

  it('normalizes open app keys when visibility is closed', () => {
    const state = validState({
      session: {
        session_workspaceByKey_ws1_openAppKeys: ['key1']
      }
    })
    const result = auditPersistedState(state.local, state.session)

    assert.equal(result.ok, false)
    assert.deepEqual(result.plan.session.session_workspaceByKey_ws1_openAppKeys, [])
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
