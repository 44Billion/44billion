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
