import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import {
  applyPendingStorageRepair,
  clearPendingStorageRepair,
  readPendingStorageRepairPlan,
  scheduleStorageRepair,
  STORAGE_REPAIR_ATTEMPTS_KEY,
  STORAGE_REPAIR_IN_PROGRESS_KEY,
  STORAGE_REPAIR_PLAN_KEY
} from '#services/storage-audit/bootstrap.js'

mock.module('#f', {
  namedExports: {
    setWebStorageItem: (area, key, value) => {
      if (value === undefined) area.removeItem(key)
      else area.setItem(key, JSON.stringify(value))
    }
  }
})

mock.module('#services/storage-audit/repair.js', {
  namedExports: {
    applyStorageRepairPlan: async (plan, { localStorageArea }) => {
      for (const [key, value] of Object.entries(plan.local ?? {})) {
        if (value === null) localStorageArea.removeItem(key)
        else localStorageArea.setItem(key, JSON.stringify(value))
      }
      return { removedApps: [], removedOwners: [] }
    }
  }
})

let mockManifestAppIds = []
mock.module('#services/app-updater/index.js', {
  defaultExport: {
    async getSiteManifestAppIds () {
      return mockManifestAppIds
    }
  }
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

function pendingPlan (codeVersion = 'v1') {
  return {
    version: 1,
    codeVersion,
    issues: [],
    local: { session_to_remove: null },
    session: {},
    removeWorkspaces: [],
    removeAppInstances: [],
    removeApps: [],
    removeAccounts: [],
    removeNostrDbOwners: [],
    releaseSubdomains: []
  }
}

describe('storage audit bootstrap', () => {
  it('schedules, retries, and stops after the attempt limit', async () => {
    const local = storageMock({
      session_appById_orphan_name: JSON.stringify('Orphan')
    })
    const session = storageMock()
    const reloads = []
    const opts = {
      localStorageArea: local,
      sessionStorageArea: session,
      codeVersion: 'v1',
      reload: () => reloads.push(true)
    }

    assert.equal(await scheduleStorageRepair(opts), true)
    assert.equal(readPendingStorageRepairPlan(local)?.codeVersion, 'v1')
    assert.equal(local.getItem(STORAGE_REPAIR_ATTEMPTS_KEY), '1')

    assert.equal(await scheduleStorageRepair(opts), true)
    assert.equal(local.getItem(STORAGE_REPAIR_ATTEMPTS_KEY), '2')

    assert.equal(await scheduleStorageRepair(opts), true)
    assert.equal(local.getItem(STORAGE_REPAIR_ATTEMPTS_KEY), '3')

    assert.equal(await scheduleStorageRepair(opts), false)
    assert.equal(reloads.length, 3)
    assert.equal(local.getItem(STORAGE_REPAIR_PLAN_KEY) != null, true)
    assert.equal(local.getItem(STORAGE_REPAIR_IN_PROGRESS_KEY), '1')
  })

  it('applies a pending plan and clears the repair markers', async () => {
    const local = storageMock({
      session_to_remove: JSON.stringify({ broken: true }),
      [STORAGE_REPAIR_PLAN_KEY]: JSON.stringify(pendingPlan()),
      [STORAGE_REPAIR_IN_PROGRESS_KEY]: '1',
      [STORAGE_REPAIR_ATTEMPTS_KEY]: '1'
    })
    const session = storageMock()

    const applied = await applyPendingStorageRepair({
      localStorageArea: local,
      sessionStorageArea: session,
      codeVersion: 'v1'
    })

    assert.equal(applied, true)
    assert.equal(local.getItem('session_to_remove'), null)
    assert.equal(local.getItem(STORAGE_REPAIR_PLAN_KEY), null)
    assert.equal(local.getItem(STORAGE_REPAIR_IN_PROGRESS_KEY), null)
    assert.equal(local.getItem(STORAGE_REPAIR_ATTEMPTS_KEY), null)
  })

  it('does not reload for a pending plan without actionable issues', async () => {
    const local = storageMock({
      [STORAGE_REPAIR_PLAN_KEY]: JSON.stringify(pendingPlan()),
      [STORAGE_REPAIR_IN_PROGRESS_KEY]: '1',
      [STORAGE_REPAIR_ATTEMPTS_KEY]: '1'
    })
    const session = storageMock()
    const reloads = []

    const scheduled = await scheduleStorageRepair({
      localStorageArea: local,
      sessionStorageArea: session,
      codeVersion: 'v1',
      reload: () => reloads.push(true)
    })

    assert.equal(scheduled, false)
    assert.deepEqual(reloads, [])
    assert.equal(local.getItem(STORAGE_REPAIR_PLAN_KEY), null)
    assert.equal(local.getItem(STORAGE_REPAIR_IN_PROGRESS_KEY), null)
    assert.equal(local.getItem(STORAGE_REPAIR_ATTEMPTS_KEY), null)
  })

  it('does not flag metadata of app ids that still own a site manifest', async () => {
    const local = storageMock({
      session_appById_retainedapp_name: JSON.stringify('Retained')
    })
    const session = storageMock()
    const reloads = []
    mockManifestAppIds = ['retainedapp']
    try {
      const scheduled = await scheduleStorageRepair({
        localStorageArea: local,
        sessionStorageArea: session,
        codeVersion: 'v1',
        reload: () => reloads.push(true)
      })

      assert.equal(scheduled, false)
      assert.deepEqual(reloads, [])
      assert.equal(local.getItem(STORAGE_REPAIR_PLAN_KEY), null)
    } finally {
      mockManifestAppIds = []
    }
  })

  it('logs how long the audit took to complete', async () => {
    const local = storageMock()
    const session = storageMock()
    const infos = []
    const originalInfo = console.info
    console.info = (...args) => infos.push(args.join(' '))
    try {
      await scheduleStorageRepair({
        localStorageArea: local,
        sessionStorageArea: session,
        codeVersion: 'v1',
        reload: () => {}
      })

      assert.equal(
        infos.some(line => /\[storage-audit\] Audit completed in \d+ms/.test(line)),
        true
      )
      assert.equal(
        infos.some(line => /site manifests: \d+ms, persisted state: \d+ms/.test(line)),
        true
      )
    } finally {
      console.info = originalInfo
    }
  })

  it('discards a stale plan without applying it', async () => {
    const local = storageMock({
      session_to_remove: JSON.stringify({ broken: true }),
      [STORAGE_REPAIR_PLAN_KEY]: JSON.stringify(pendingPlan('old-version')),
      [STORAGE_REPAIR_IN_PROGRESS_KEY]: '1'
    })
    const session = storageMock()

    const applied = await applyPendingStorageRepair({
      localStorageArea: local,
      sessionStorageArea: session,
      codeVersion: 'new-version'
    })

    assert.equal(applied, false)
    assert.notEqual(local.getItem('session_to_remove'), null)
    assert.equal(local.getItem(STORAGE_REPAIR_PLAN_KEY), null)
    assert.equal(local.getItem(STORAGE_REPAIR_IN_PROGRESS_KEY), null)
  })

  it('removes an orphaned in-progress flag when no plan exists', async () => {
    const local = storageMock({ [STORAGE_REPAIR_IN_PROGRESS_KEY]: '1' })
    const session = storageMock()

    const applied = await applyPendingStorageRepair({
      localStorageArea: local,
      sessionStorageArea: session,
      codeVersion: 'v1'
    })

    assert.equal(applied, false)
    assert.equal(local.getItem(STORAGE_REPAIR_IN_PROGRESS_KEY), null)
  })

  it('normalizes derived lists on every load even without a repair plan', async () => {
    const local = storageMock({
      session_workspaceKeys: JSON.stringify(['ws1', 'ws1']),
      session_accountUserPks: JSON.stringify(['user', 'user']),
      session_openWorkspaceKeys: JSON.stringify(['ws1', 'ghost']),
      session_workspaceByKey_ws1_pinnedAppIds: JSON.stringify(['app1']),
      session_workspaceByKey_ws1_unpinnedAppIds: JSON.stringify([]),
      session_workspaceByKey_ws1_appById_app1_appKeys: JSON.stringify(['key1']),
      session_appByKey_key1_id: JSON.stringify('app1')
    })
    const session = storageMock({
      session_workspaceByKey_ws1_openAppKeys: JSON.stringify(['key1', 'key1', 'ghost']),
      session_appByKey_key1_visibility: JSON.stringify('open')
    })
    const warns = []
    const originalWarn = console.warn
    console.warn = (...args) => warns.push(args.join(' '))
    try {
      const applied = await applyPendingStorageRepair({
        localStorageArea: local,
        sessionStorageArea: session,
        codeVersion: 'v1'
      })

      assert.equal(applied, false)
      assert.deepEqual(JSON.parse(local.getItem('session_workspaceKeys')), ['ws1'])
      assert.deepEqual(JSON.parse(local.getItem('session_accountUserPks')), ['user'])
      assert.deepEqual(JSON.parse(local.getItem('session_openWorkspaceKeys')), ['ws1'])
      assert.deepEqual(JSON.parse(session.getItem('session_workspaceByKey_ws1_openAppKeys')), ['key1'])
      assert.equal(warns.length, 4)
      assert.match(warns[0], /Normalized session_workspaceKeys/)
      assert.match(warns[1], /Normalized session_accountUserPks/)
      assert.match(warns[2], /Normalized session_openWorkspaceKeys/)
      assert.match(warns[3], /Normalized openAppKeys for workspace ws1/)
    } finally {
      console.warn = originalWarn
    }
  })

  it('skips stage-one scheduling while another tab holds the lock', async () => {
    const local = storageMock({ session_appById_orphan_name: JSON.stringify('Orphan') })
    const session = storageMock()
    const reloads = []
    const navigatorArea = {
      locks: {
        request (name, options, callback) {
          assert.equal(name, 'storage-audit-repair')
          if (options.ifAvailable) return Promise.resolve()
          return callback({})
        }
      }
    }

    const scheduled = await scheduleStorageRepair({
      localStorageArea: local,
      sessionStorageArea: session,
      navigatorArea,
      codeVersion: 'v1',
      reload: () => reloads.push(true)
    })

    assert.equal(scheduled, false)
    assert.equal(reloads.length, 0)
    assert.equal(local.getItem(STORAGE_REPAIR_PLAN_KEY), null)
  })

  it('clears all journal keys', () => {
    const local = storageMock({
      [STORAGE_REPAIR_PLAN_KEY]: '{}',
      [STORAGE_REPAIR_IN_PROGRESS_KEY]: '1',
      [STORAGE_REPAIR_ATTEMPTS_KEY]: '2'
    })

    clearPendingStorageRepair(local)

    assert.equal(local.getItem(STORAGE_REPAIR_PLAN_KEY), null)
    assert.equal(local.getItem(STORAGE_REPAIR_IN_PROGRESS_KEY), null)
    assert.equal(local.getItem(STORAGE_REPAIR_ATTEMPTS_KEY), null)
  })
})

it('normalizes subdomain bookkeeping before rendering without a repair plan or repeated writes', async t => {
  const local = storageMock({
    session_subdomainNextId: '2',
    session_subdomainFreeIds: '["6"]',
    session_subdomainToApp_9: JSON.stringify({ userPk: 'user', appId: 'app' }),
    session_subdomainByUserAndApp_user_app: '"9"',
    local_subdomainLifecycle: JSON.stringify({ version: 1, pending: [], assignments: { 7: 'interrupted', 9: 'live' } })
  })
  const options = { localStorageArea: local, sessionStorageArea: storageMock(), codeVersion: 'v1' }
  assert.equal(await applyPendingStorageRepair(options), false)
  assert.equal(local.getItem('session_subdomainNextId'), '10')
  assert.deepEqual(JSON.parse(local.getItem('local_subdomainLifecycle')), {
    version: 1, pending: ['7'], assignments: { 7: 'interrupted', 9: 'live' }
  })
  assert.equal(local.getItem('session_subdomainFreeIds'), '["6"]')
  assert.equal(local.getItem('session_subdomainByUserAndApp_user_app'), '"9"')
  const writes = t.mock.method(local, 'setItem')
  await applyPendingStorageRepair(options)
  assert.equal(writes.mock.callCount(), 0)
  const reload = t.mock.fn()
  assert.equal(await scheduleStorageRepair({ ...options, reload }), false)
  assert.equal(reload.mock.callCount(), 0)
  assert.equal(local.getItem(STORAGE_REPAIR_PLAN_KEY), null)
})

it('handles late maintenance and legacy maintenance-only plans without reloading', async t => {
  for (const withOldPlan of [false, true]) {
    const local = storageMock({
      session_subdomainNextId: '0',
      local_subdomainLifecycle: JSON.stringify({ version: 1, pending: [], assignments: { 7: 'interrupted' } })
    })
    if (withOldPlan) {
      local.setItem(STORAGE_REPAIR_PLAN_KEY, JSON.stringify({
        ...pendingPlan(),
        issues: [{ code: 'orphan_subdomain_assignment' }, { code: 'subdomain_counter_behind' }],
        local: { session_subdomainNextId: 8 },
        releaseSubdomains: [{ subdomain: '7' }]
      }))
    }
    const reload = t.mock.fn()
    assert.equal(await scheduleStorageRepair({
      localStorageArea: local, sessionStorageArea: storageMock(), codeVersion: 'v1', reload
    }), false)
    assert.equal(reload.mock.callCount(), 0)
    assert.equal(local.getItem('session_subdomainNextId'), '8')
    assert.deepEqual(JSON.parse(local.getItem('local_subdomainLifecycle')).pending, ['7'])
    assert.equal(local.getItem(STORAGE_REPAIR_PLAN_KEY), null)
  }
})

it('does not apply stale maintenance-only writes to a replacement mapping before rendering', async () => {
  const local = storageMock({
    session_subdomainNextId: '20',
    session_subdomainToApp_7: JSON.stringify({ userPk: 'new', appId: 'app' }),
    session_subdomainByUserAndApp_new_app: '"7"',
    local_subdomainLifecycle: JSON.stringify({ version: 1, pending: [], assignments: { 7: 'new' } }),
    [STORAGE_REPAIR_PLAN_KEY]: JSON.stringify({
      ...pendingPlan(), issues: [{ code: 'subdomain_counter_behind' }], local: { session_subdomainNextId: 8 }
    })
  })
  assert.equal(await applyPendingStorageRepair({
    localStorageArea: local, sessionStorageArea: storageMock(), codeVersion: 'v1'
  }), false)
  assert.equal(local.getItem('session_subdomainNextId'), '20')
  assert.deepEqual(JSON.parse(local.getItem('local_subdomainLifecycle')).pending, [])
  assert.equal(local.getItem('session_subdomainByUserAndApp_new_app'), '"7"')
  assert.equal(local.getItem(STORAGE_REPAIR_PLAN_KEY), null)
})

it('still schedules reload for broken mappings alongside harmless maintenance', async t => {
  const local = storageMock({
    session_subdomainNextId: '0',
    session_subdomainToApp_3: '{"broken":true}',
    local_subdomainLifecycle: JSON.stringify({ version: 1, pending: [], assignments: { 7: 'interrupted' } })
  })
  const reload = t.mock.fn()
  assert.equal(await scheduleStorageRepair({
    localStorageArea: local, sessionStorageArea: storageMock(), codeVersion: 'v1', reload
  }), true)
  assert.equal(reload.mock.callCount(), 1)
  const plan = readPendingStorageRepairPlan(local)
  assert.ok(plan.issues.some(issue => issue.code === 'invalid_subdomain_mapping'))
  assert.ok(!plan.issues.some(issue => issue.code === 'orphan_subdomain_assignment'))
})

it('waits for another tab to finish its mapping write before normalizing and auditing', async t => {
  const { withSubdomainLock } = await import('#helpers/subdomain-mapping.js')
  const local = storageMock({
    local_subdomainLifecycle: JSON.stringify({ version: 1, pending: [], assignments: { 7: 'new' } })
  })
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const writer = withSubdomainLock(async () => {
    local.setItem('session_subdomainToApp_7', JSON.stringify({ userPk: 'user', appId: 'app' }))
    entered.resolve()
    await finish.promise
    local.setItem('session_subdomainByUserAndApp_user_app', '"7"')
  })
  await entered.promise
  const reload = t.mock.fn()
  let settled = false
  const audit = scheduleStorageRepair({
    localStorageArea: local, sessionStorageArea: storageMock(), codeVersion: 'v1', reload
  }).then(result => { settled = true; return result })
  try {
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(settled, false)
  } finally { finish.resolve() }
  await writer
  assert.equal(await audit, false)
  assert.equal(reload.mock.callCount(), 0)
  assert.deepEqual(JSON.parse(local.getItem('local_subdomainLifecycle')).pending, [])
})

it('quarantines legacy free IDs and repairs an invalid counter without reloading', async t => {
  const local = storageMock({ session_subdomainFreeIds: '["7"]', session_subdomainNextId: '"invalid"' })
  const options = { localStorageArea: local, sessionStorageArea: storageMock(), codeVersion: 'v1' }
  await applyPendingStorageRepair(options)
  assert.equal(local.getItem('session_subdomainNextId'), '8')
  assert.equal(local.getItem('session_subdomainFreeIds'), null)
  assert.deepEqual(JSON.parse(local.getItem('local_subdomainLifecycle')), {
    version: 1, pending: ['7'], assignments: {}
  })
  const reload = t.mock.fn()
  assert.equal(await scheduleStorageRepair({ ...options, reload }), false)
  assert.equal(reload.mock.callCount(), 0)
})
