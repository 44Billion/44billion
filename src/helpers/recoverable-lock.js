const VERSION = 1
const NOT_ACQUIRED = Symbol('not-acquired')
const fallbackMemories = new WeakMap()
const nonPersistentStorages = new WeakSet()
const localQueues = new WeakMap()
const defaultLocalQueues = new Map()
const memoryStorage = {
  values: new Map(),
  getItem (key) { return this.values.get(key) ?? null },
  setItem (key, value) { this.values.set(key, value) }
}
const defaultReplicaId = globalThis.crypto?.randomUUID?.() ||
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

function defaultStorage () {
  try { return globalThis.localStorage || null } catch { return null }
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

export function readWebLockLease (storageKey, storage = defaultStorage()) {
  const area = storage || memoryStorage
  const source = storage && nonPersistentStorages.has(storage) ? fallbackMemory(storage) : area
  try { return normalizeLease(JSON.parse(source.getItem(storageKey) || 'null')) } catch { return null }
}

function writeWebLockLease (storageKey, lease, storage = defaultStorage()) {
  const area = storage || memoryStorage
  const serialized = JSON.stringify(lease)
  try {
    area.setItem(storageKey, serialized)
  } catch {
    if (storage) nonPersistentStorages.add(storage)
  }
  fallbackMemory(storage).setItem(storageKey, serialized)
  if (storage) {
    try {
      if (storage.getItem(storageKey) === serialized) nonPersistentStorages.delete(storage)
      else nonPersistentStorages.add(storage)
    } catch {
      nonPersistentStorages.add(storage)
    }
  }
  return lease
}

function withLocalQueue (scope, name, callback, replicaId) {
  let map = defaultLocalQueues
  if (scope && (typeof scope === 'object' || typeof scope === 'function')) {
    map = localQueues.get(scope)
    if (!map) {
      map = new Map()
      localQueues.set(scope, map)
    }
  }
  const previous = map.get(name) || Promise.resolve()
  const next = previous.catch(() => {}).then(() => {
    const controller = new AbortController()
    return callback({
      signal: controller.signal,
      generation: 1,
      instanceId: replicaId,
      assertLeader () {}
    })
  })
  map.set(name, next.catch(() => {}))
  return next
}

export async function withRecoverableLock ({
  name,
  storageKey,
  callback,
  locks = globalThis.navigator?.locks,
  storage = defaultStorage(),
  fallbackScope,
  requireWebLocks = false,
  unavailableError = () => Object.assign(new Error(`Web Lock coordination unavailable: ${name}`), { code: 'unavailable' }),
  authorityLostError = () => Object.assign(new Error('LOCK_AUTHORITY_LOST'), { code: 'LOCK_AUTHORITY_LOST' }),
  assertLeaderOnFinish = false,
  onWait,
  onExecution,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  heartbeatMs = 10_000,
  leaseMs = 30_000,
  replicaId = defaultReplicaId
}) {
  if (typeof callback !== 'function') throw new TypeError('RECOVERABLE_LOCK_CALLBACK_REQUIRED')
  if (typeof locks?.request !== 'function') {
    if (requireWebLocks) throw unavailableError()
    return withLocalQueue(fallbackScope, name, callback, replicaId)
  }

  const queuedAt = performance.now()
  const run = lock => {
    if (!lock) return NOT_ACQUIRED
    const acquiredAt = performance.now()
    onWait?.(acquiredAt - queuedAt)
    return (async () => {
      const current = readWebLockLease(storageKey, storage)
      const generation = Math.max(1, (current?.generation || 0) + 1)
      const startedAt = now()
      const controller = new AbortController()
      let heartbeatTimer = null
      let authorityError = null
      const owns = () => {
        const lease = readWebLockLease(storageKey, storage)
        return lease?.instanceId === replicaId &&
          lease?.generation === generation &&
          lease.leaseUntil > now()
      }
      const assertLeader = () => {
        if (controller.signal.aborted || !owns()) throw authorityError || authorityLostError()
      }
      const persist = leaseUntil => writeWebLockLease(storageKey, {
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
            if (!owns()) throw authorityLostError()
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
        if (assertLeaderOnFinish) assertLeader()
        return result
      } catch (error) {
        if (authorityError) throw authorityError
        throw error
      } finally {
        if (heartbeatTimer != null) clearTimer(heartbeatTimer)
        if (owns()) {
          try { persist(0) } catch {}
        }
        onExecution?.(performance.now() - acquiredAt)
      }
    })()
  }

  while (true) {
    const immediate = await locks.request(name, { ifAvailable: true }, lock => lock ? run(lock) : NOT_ACQUIRED)
    if (immediate !== NOT_ACQUIRED) return immediate

    const currentTime = now()
    const lease = readWebLockLease(storageKey, storage)
    if (lease && lease.instanceId !== replicaId && lease.leaseUntil > 0 && lease.leaseUntil <= currentTime) {
      return locks.request(name, { steal: true }, run)
    }

    // Active foreign lease: wait with a bounded AbortSignal until leaseUntil so
    // a frozen holder cannot deadlock waiters that arrived before expiry.
    if (lease && lease.instanceId !== replicaId && lease.leaseUntil > currentTime) {
      const waitMs = Math.max(50, Math.min(leaseMs, lease.leaseUntil - currentTime))
      const controller = new AbortController()
      let waitTimer = setTimer(() => {
        waitTimer = null
        controller.abort(new Error('LOCK_WAIT_EXPIRED'))
      }, waitMs)
      waitTimer?.unref?.()
      try {
        return await locks.request(name, { signal: controller.signal }, lock => {
          if (waitTimer != null) { clearTimer(waitTimer); waitTimer = null }
          return run(lock)
        })
      } catch (error) {
        if (waitTimer != null) { clearTimer(waitTimer); waitTimer = null }
        if (controller.signal.aborted) continue
        throw error
      }
    }

    // Own lease, completed lease (leaseUntil === 0), or legacy holder without a lease.
    return locks.request(name, {}, run)
  }
}
