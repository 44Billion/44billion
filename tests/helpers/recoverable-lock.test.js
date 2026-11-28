import assert from 'node:assert/strict'
import { it, mock } from 'node:test'
import {
  SUBDOMAIN_LOCK_LEASE_KEY,
  CHUNK_CACHE_LOCK_LEASE_KEY,
  NOSTRDB_ACCOUNT_ACCESS_LOCK_LEASE_KEY
} from '#constants/storage-schema.js'
import { readWebLockLease, withRecoverableLock } from '#helpers/recoverable-lock.js'

mock.module('#f', {
  namedExports: {
    setWebStorageItem: (area, key, value) => {
      if (value === undefined) area.removeItem(key)
      else area.setItem(key, JSON.stringify(value))
    }
  }
})

const { withSubdomainLock } = await import('#helpers/subdomain-mapping.js')
const { withChunkCacheLock } = await import('#services/idb/browser/queries/chunk-cache.js')
const { reconcileNostrDbAccounts } = await import('#services/nostrdb-account-lifecycle.js')

function createFakeStorage () {
  const values = new Map()
  return {
    get length () { return values.size },
    key: i => [...values.keys()][i] ?? null,
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  }
}

function createFakeLocks () {
  const held = new Map()
  const waiters = new Map()

  const queueOf = name => {
    let list = waiters.get(name)
    if (!list) {
      list = []
      waiters.set(name, list)
    }
    return list
  }

  function grant (name, callback) {
    const token = Symbol(name)
    held.set(name, token)
    const release = () => {
      if (held.get(name) !== token) return
      held.delete(name)
      const list = queueOf(name)
      while (list.length) {
        const next = list.shift()
        if (next.aborted) continue
        next.grant()
        break
      }
    }
    return Promise.resolve().then(() => callback({ name })).finally(release)
  }

  return {
    request (name, optionsOrCallback, maybeCallback) {
      const hasOptions = typeof optionsOrCallback === 'object' && optionsOrCallback !== null
      const options = hasOptions ? optionsOrCallback : {}
      const callback = hasOptions ? maybeCallback : optionsOrCallback
      if (options.steal) {
        held.delete(name)
        return grant(name, callback)
      }
      if (!held.has(name)) return grant(name, callback)
      if (options.ifAvailable) return Promise.resolve().then(() => callback(null))
      return new Promise((resolve, reject) => {
        const signal = options.signal
        if (signal?.aborted) {
          reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }))
          return
        }
        const entry = {
          aborted: false,
          grant () {
            signal?.removeEventListener('abort', onAbort)
            grant(name, callback).then(resolve, reject)
          }
        }
        const onAbort = () => {
          entry.aborted = true
          reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        queueOf(name).push(entry)
      })
    }
  }
}

it('withSubdomainLock and withChunkCacheLock recover from a frozen tab after lease expiry', async () => {
  for (const { run, leaseKey } of [
    { run: (fn, opts) => withSubdomainLock(fn, opts), leaseKey: SUBDOMAIN_LOCK_LEASE_KEY },
    { run: (fn, opts) => withChunkCacheLock(fn, opts), leaseKey: CHUNK_CACHE_LOCK_LEASE_KEY }
  ]) {
    const locks = createFakeLocks()
    const storage = createFakeStorage()
    let clock = 10_000
    let releaseFrozen

    const frozen = run(async () => {
      await new Promise(resolve => { releaseFrozen = resolve })
      return 'frozen'
    }, {
      locks,
      storage,
      now: () => clock,
      setTimer: () => ({ unref () {} }),
      clearTimer: () => {},
      leaseMs: 1_000,
      heartbeatMs: 300,
      replicaId: 'tab-a'
    })

    await new Promise(resolve => setImmediate(resolve))
    assert.equal(readWebLockLease(leaseKey, storage)?.instanceId, 'tab-a')

    clock = 10_300
    const timers = []
    const recovered = run(() => 'recovered', {
      locks,
      storage,
      now: () => clock,
      setTimer: (fn, ms) => {
        const timer = { fn, ms, unref () {} }
        timers.push(timer)
        return timer
      },
      clearTimer: () => {},
      leaseMs: 1_000,
      heartbeatMs: 300,
      replicaId: 'tab-b'
    })

    await new Promise(resolve => setImmediate(resolve))
    assert.equal(timers[0].ms, 700)
    clock = 11_000
    timers[0].fn()
    assert.equal(await recovered, 'recovered')
    releaseFrozen()
    await frozen
  }
})

it('reconcileNostrDbAccounts aborts stale writes when leadership was lost while frozen', async () => {
  const locks = createFakeLocks()
  const storage = createFakeStorage()
  let clock = 20_000
  const owner = 'a'.repeat(64)
  let releaseDelete

  const frozenReconcile = reconcileNostrDbAccounts([{ pubkey: owner, isReadOnly: true }], {
    storage,
    write: (area, key, value) => value === undefined ? area.removeItem(key) : area.setItem(key, JSON.stringify(value)),
    lock: cb => withRecoverableLock({
      name: '44billion:nostrdb-account-access:v1',
      storageKey: NOSTRDB_ACCOUNT_ACCESS_LOCK_LEASE_KEY,
      callback: cb,
      locks,
      storage,
      requireWebLocks: true,
      now: () => clock,
      setTimer: () => ({ unref () {} }),
      clearTimer: () => {},
      leaseMs: 1_000,
      heartbeatMs: 300,
      replicaId: 'tab-a'
    }),
    deleteDb: async () => {
      await new Promise(resolve => { releaseDelete = resolve })
      return true
    },
    reportError: () => {}
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(readWebLockLease(NOSTRDB_ACCOUNT_ACCESS_LOCK_LEASE_KEY, storage)?.instanceId, 'tab-a')

  // Lease expires and tab B takes over.
  clock = 22_000
  const replacement = await withRecoverableLock({
    name: '44billion:nostrdb-account-access:v1',
    storageKey: NOSTRDB_ACCOUNT_ACCESS_LOCK_LEASE_KEY,
    callback: () => 'taken-over',
    locks,
    storage,
    requireWebLocks: true,
    now: () => clock,
    leaseMs: 1_000,
    heartbeatMs: 300,
    replicaId: 'tab-b'
  })
  assert.equal(replacement, 'taken-over')

  // Tab A thaws after deleteDb resolves -> must reject with LOCK_AUTHORITY_LOST before mutating storage.
  releaseDelete()
  await assert.rejects(frozenReconcile, { code: 'LOCK_AUTHORITY_LOST' })
})
