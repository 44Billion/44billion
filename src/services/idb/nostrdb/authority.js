import { NOSTRDB_AUTHORITY_KEY } from '#constants/storage-schema.js'
import { readWebLockLease, withRecoverableLock } from '#helpers/recoverable-lock.js'
import { recordPerformance } from '#services/performance-diagnostics.js'

export const QUOTA_LOCK = '44billion:nostrdb-quota:v1'
export const AUTHORITY_HEARTBEAT_MS = 10_000
export const AUTHORITY_LEASE_MS = 30_000

function unavailable () {
  return Object.assign(new Error('NostrDB quota coordination is unavailable'), { code: 'unavailable' })
}

function authorityLost () {
  return Object.assign(new Error('NOSTRDB_AUTHORITY_LOST'), { code: 'NOSTRDB_AUTHORITY_LOST' })
}

export function readNostrDbAuthority (storage = globalThis.localStorage) {
  return readWebLockLease(NOSTRDB_AUTHORITY_KEY, storage)
}

function reportTiming (onTiming, entry) {
  try {
    if (onTiming) onTiming(entry)
    else if (typeof IS_DEVELOPMENT !== 'undefined' && IS_DEVELOPMENT) recordPerformance(entry)
  } catch {}
}

export async function withNostrDbAuthority (callback, onTiming, {
  locks = globalThis.navigator?.locks,
  storage = globalThis.localStorage,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  heartbeatMs = AUTHORITY_HEARTBEAT_MS,
  leaseMs = AUTHORITY_LEASE_MS,
  replicaId
} = {}) {
  if (!locks?.request) throw unavailable()
  if (typeof callback !== 'function') throw new TypeError('NOSTRDB_AUTHORITY_CALLBACK_REQUIRED')

  return withRecoverableLock({
    name: QUOTA_LOCK,
    storageKey: NOSTRDB_AUTHORITY_KEY,
    callback,
    locks,
    storage,
    requireWebLocks: true,
    unavailableError: unavailable,
    authorityLostError: authorityLost,
    assertLeaderOnFinish: true,
    onWait: elapsedMs => reportTiming(onTiming, { stage: 'quota-lock-wait', elapsedMs }),
    onExecution: elapsedMs => reportTiming(onTiming, { stage: 'quota-lock-execution', elapsedMs }),
    now,
    setTimer,
    clearTimer,
    heartbeatMs,
    leaseMs,
    ...(replicaId === undefined ? {} : { replicaId })
  })
}
