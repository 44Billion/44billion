import { NOSTRDB_AUTHORITY_KEY } from '#constants/storage-schema.js'
import { recordPerformance } from '#services/performance-diagnostics.js'

export const QUOTA_LOCK = '44billion:nostrdb-quota:v1'
export const AUTHORITY_HEARTBEAT_MS = 10_000
export const AUTHORITY_LEASE_MS = 30_000

const VERSION = 1
const NOT_ACQUIRED = Symbol('not-acquired')
const fallbackMemories = new WeakMap()
const nonPersistentStorages = new WeakSet()
const memoryStorage = {
  values: new Map(),
  getItem (key) { return this.values.get(key) ?? null },
  setItem (key, value) { this.values.set(key, value) }
}
const instanceId = globalThis.crypto?.randomUUID?.() ||
  `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`

function fallbackMemory (storage) {
  if (!storage) return memoryStorage
  let memory = fallbackMemories.get(storage)
  if (!memory) {
    memory = { values: new Map() }
    fallbackMemories.set(storage, memory)
  }
  return {
    getItem: key => memory.values.get(key) ?? null,
    setItem: (key, value) => memory.values.set(key, value)
  }
}

function unavailable () {
  return Object.assign(new Error('NostrDB quota coordination is unavailable'), { code: 'unavailable' })
}

function authorityLost () {
  return Object.assign(new Error('NOSTRDB_AUTHORITY_LOST'), { code: 'NOSTRDB_AUTHORITY_LOST' })
}

function normalizeLease (value) {
  return value &&
    value.version === VERSION &&
    Number.isSafeInteger(value.generation) && value.generation >= 0 &&
    typeof value.instanceId === 'string' && value.instanceId &&
    Number.isFinite(value.leaseUntil) && value.leaseUntil >= 0 &&
    Number.isFinite(value.updatedAt) && value.updatedAt >= 0
    ? value
    : null
}

export function readNostrDbAuthority (storage = globalThis.localStorage) {
  const area = storage || memoryStorage
  const source = storage && nonPersistentStorages.has(storage) ? fallbackMemory(storage) : area
  try { return normalizeLease(JSON.parse(source.getItem(NOSTRDB_AUTHORITY_KEY) || 'null')) } catch { return null }
}

function writeNostrDbAuthority (lease, storage = globalThis.localStorage) {
  const area = storage || memoryStorage
  const serialized = JSON.stringify(lease)
  area.setItem(NOSTRDB_AUTHORITY_KEY, serialized)
  fallbackMemory(storage).setItem(NOSTRDB_AUTHORITY_KEY, serialized)
  if (storage) {
    try {
      if (storage.getItem(NOSTRDB_AUTHORITY_KEY) === serialized) nonPersistentStorages.delete(storage)
      else nonPersistentStorages.add(storage)
    } catch {
      nonPersistentStorages.add(storage)
    }
  }
  return lease
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
  replicaId = instanceId
} = {}) {
  if (!locks?.request) throw unavailable()
  if (typeof callback !== 'function') throw new TypeError('NOSTRDB_AUTHORITY_CALLBACK_REQUIRED')
  const queuedAt = performance.now()

  const run = lock => {
    if (!lock) return null
    const acquiredAt = performance.now()
    reportTiming(onTiming, { stage: 'quota-lock-wait', elapsedMs: acquiredAt - queuedAt })
    return (async () => {
      const current = readNostrDbAuthority(storage)
      const generation = Math.max(1, (current?.generation || 0) + 1)
      const startedAt = now()
      const controller = new AbortController()
      let heartbeatTimer = null
      let authorityError = null
      const owns = () => {
        const lease = readNostrDbAuthority(storage)
        return lease?.instanceId === replicaId &&
          lease?.generation === generation &&
          lease.leaseUntil > now()
      }
      const assertLeader = () => {
        if (controller.signal.aborted || !owns()) throw authorityError || authorityLost()
      }
      const persist = leaseUntil => writeNostrDbAuthority({
        version: VERSION,
        generation,
        instanceId: replicaId,
        leaseUntil,
        updatedAt: now()
      }, storage)
      const scheduleHeartbeat = () => {
        heartbeatTimer = setTimer(() => {
          heartbeatTimer = null
          try {
            if (!owns()) throw authorityLost()
            persist(now() + leaseMs)
            scheduleHeartbeat()
          } catch (error) {
            authorityError = error
            controller.abort(error)
          }
        }, heartbeatMs)
        heartbeatTimer?.unref?.()
      }

      try {
        persist(startedAt + leaseMs)
        scheduleHeartbeat()
        const result = await callback({
          signal: controller.signal,
          generation,
          instanceId: replicaId,
          assertLeader
        })
        if (authorityError) throw authorityError
        assertLeader()
        return result
      } catch (error) {
        if (authorityError) throw authorityError
        throw error
      } finally {
        if (heartbeatTimer != null) clearTimer(heartbeatTimer)
        if (owns()) {
          try {
            persist(0)
          } catch {}
        }
        reportTiming(onTiming, { stage: 'quota-lock-execution', elapsedMs: performance.now() - acquiredAt })
      }
    })()
  }

  const immediate = await locks.request(QUOTA_LOCK, { ifAvailable: true }, lock => lock ? run(lock) : NOT_ACQUIRED)
  if (immediate !== NOT_ACQUIRED) return immediate

  const lease = readNostrDbAuthority(storage)
  if (lease && lease.instanceId !== replicaId && lease.leaseUntil > now()) {
    return locks.request(QUOTA_LOCK, {}, run)
  }
  if (lease?.instanceId !== replicaId && lease?.leaseUntil > 0 && lease.leaseUntil <= now()) {
    return locks.request(QUOTA_LOCK, { steal: true }, run)
  }
  return locks.request(QUOTA_LOCK, {}, run)
}
