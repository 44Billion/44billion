import { auditPersistedState, hasStorageRepairActions } from './audit.js'

export const STORAGE_REPAIR_PLAN_KEY = 'local_pendingStorageRepairPlan'
export const STORAGE_REPAIR_IN_PROGRESS_KEY = 'local_storageRepairInProgress'
export const STORAGE_REPAIR_ATTEMPTS_KEY = 'local_storageRepairAttempts'

const LOCK_NAME = 'storage-audit-repair'
const MAX_REPAIR_ATTEMPTS = 3
let lastDevelopmentPlanFingerprint = null

function currentCodeVersion () {
  return typeof LAUNCHER_DEPLOY_HASH === 'string' ? LAUNCHER_DEPLOY_HASH : ''
}

function isDevelopment () {
  return typeof IS_DEVELOPMENT === 'boolean' ? IS_DEVELOPMENT : false
}

function parsePlan (raw) {
  if (!raw) return null
  try {
    const plan = JSON.parse(raw)
    return plan && plan.version ? plan : null
  } catch {
    return null
  }
}

export function readPendingStorageRepairPlan (localStorageArea = globalThis.localStorage) {
  return parsePlan(localStorageArea?.getItem?.(STORAGE_REPAIR_PLAN_KEY))
}

export function clearPendingStorageRepair (localStorageArea = globalThis.localStorage) {
  localStorageArea?.removeItem?.(STORAGE_REPAIR_PLAN_KEY)
  localStorageArea?.removeItem?.(STORAGE_REPAIR_IN_PROGRESS_KEY)
  localStorageArea?.removeItem?.(STORAGE_REPAIR_ATTEMPTS_KEY)
}

function attemptsValue (localStorageArea) {
  const value = Number(localStorageArea?.getItem?.(STORAGE_REPAIR_ATTEMPTS_KEY) || 0)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

async function withExclusiveLock (navigatorArea, ifAvailable, callback) {
  const locks = navigatorArea?.locks
  if (!locks || typeof locks.request !== 'function') {
    await callback()
    return
  }

  await locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable }, async lock => {
    if (ifAvailable && !lock) return
    await callback()
  })
}

function isStalePlan (plan, codeVersion) {
  return plan.codeVersion !== codeVersion
}

function summarizePlan (plan) {
  const issueCounts = {}
  for (const issue of plan.issues ?? []) {
    issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1
  }
  return {
    issueCounts,
    localWrites: Object.keys(plan.local ?? {}),
    sessionWrites: Object.keys(plan.session ?? {}),
    removeWorkspaces: plan.removeWorkspaces?.length ?? 0,
    removeAppInstances: plan.removeAppInstances?.length ?? 0,
    removeApps: plan.removeApps?.length ?? 0,
    removeAccounts: plan.removeAccounts?.length ?? 0,
    releaseSubdomains: plan.releaseSubdomains?.length ?? 0
  }
}

function planFingerprint (summary) {
  return JSON.stringify({
    issueCounts: Object.entries(summary.issueCounts)
      .sort(([left], [right]) => left.localeCompare(right)),
    localWrites: [...summary.localWrites].sort(),
    sessionWrites: [...summary.sessionWrites].sort(),
    removeWorkspaces: summary.removeWorkspaces,
    removeAppInstances: summary.removeAppInstances,
    removeApps: summary.removeApps,
    removeAccounts: summary.removeAccounts,
    releaseSubdomains: summary.releaseSubdomains
  })
}

export async function scheduleStorageRepair ({
  localStorageArea = globalThis.localStorage,
  sessionStorageArea = globalThis.sessionStorage,
  navigatorArea = globalThis.navigator,
  reload = () => globalThis.location?.reload(),
  codeVersion = currentCodeVersion()
} = {}) {
  if (isDevelopment()) {
    try {
      const { plan } = auditPersistedState(localStorageArea, sessionStorageArea)
      if (hasStorageRepairActions(plan)) {
        const summary = summarizePlan(plan)
        const debugSummary = { ...summary, codeVersion }
        const fingerprint = planFingerprint(summary)
        if (fingerprint !== lastDevelopmentPlanFingerprint) {
          lastDevelopmentPlanFingerprint = fingerprint
          console.warn('[storage-audit] Skipping automatic repair in development', debugSummary, JSON.stringify(debugSummary))
        } else {
          console.info('[storage-audit] Development audit re-ran; repair plan unchanged')
        }
      } else {
        lastDevelopmentPlanFingerprint = null
      }
    } catch (error) {
      console.error('[storage-audit] Development audit failed', error)
    }
    return false
  }

  let scheduled = false

  await withExclusiveLock(navigatorArea, true, async () => {
    const existingPlan = readPendingStorageRepairPlan(localStorageArea)

    if (existingPlan) {
      if (isDevelopment() || isStalePlan(existingPlan, codeVersion)) {
        clearPendingStorageRepair(localStorageArea)
      } else {
        const attempts = attemptsValue(localStorageArea)
        if (attempts >= MAX_REPAIR_ATTEMPTS) {
          console.warn('[storage-audit] Repair attempts exhausted', existingPlan.issues)
          return
        }
        localStorageArea?.setItem?.(STORAGE_REPAIR_IN_PROGRESS_KEY, '1')
        localStorageArea?.setItem?.(STORAGE_REPAIR_ATTEMPTS_KEY, String(attempts + 1))
        reload()
        scheduled = true
        return
      }
    }

    if (localStorageArea?.getItem?.(STORAGE_REPAIR_IN_PROGRESS_KEY)) {
      localStorageArea.removeItem(STORAGE_REPAIR_IN_PROGRESS_KEY)
    }

    let plan
    try {
      ({ plan } = auditPersistedState(localStorageArea, sessionStorageArea))
    } catch (error) {
      console.error('[storage-audit] Audit failed', error)
      return
    }

    if (!hasStorageRepairActions(plan)) return

    plan.codeVersion = codeVersion
    localStorageArea?.setItem?.(STORAGE_REPAIR_PLAN_KEY, JSON.stringify(plan))
    localStorageArea?.setItem?.(STORAGE_REPAIR_IN_PROGRESS_KEY, '1')
    localStorageArea?.setItem?.(STORAGE_REPAIR_ATTEMPTS_KEY, '1')
    reload()
    scheduled = true
  })

  return scheduled
}

export async function applyPendingStorageRepair ({
  localStorageArea = globalThis.localStorage,
  sessionStorageArea = globalThis.sessionStorage,
  navigatorArea = globalThis.navigator,
  codeVersion = currentCodeVersion()
} = {}) {
  if (globalThis.window && globalThis.window !== globalThis.window.top) return false

  let plan = readPendingStorageRepairPlan(localStorageArea)
  if (!plan) {
    if (localStorageArea?.getItem?.(STORAGE_REPAIR_IN_PROGRESS_KEY)) {
      localStorageArea.removeItem(STORAGE_REPAIR_IN_PROGRESS_KEY)
    }
    return false
  }

  if (isDevelopment() || isStalePlan(plan, codeVersion)) {
    clearPendingStorageRepair(localStorageArea)
    return false
  }

  let applied = false
  await withExclusiveLock(navigatorArea, false, async () => {
    plan = readPendingStorageRepairPlan(localStorageArea)
    if (!plan || isDevelopment() || isStalePlan(plan, codeVersion)) return

    try {
      const { applyStorageRepairPlan } = await import('./repair.js')
      await applyStorageRepairPlan(plan, { localStorageArea, sessionStorageArea })
      applied = true
    } catch (error) {
      console.error('[storage-audit] Repair failed', error)
    }
  })

  if (applied) clearPendingStorageRepair(localStorageArea)
  return applied
}
