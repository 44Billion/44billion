import assert from 'node:assert/strict'
import { it } from 'node:test'
import { NOSTRDB_AUTHORITY_KEY } from '#constants/storage-schema.js'
import {
  AUTHORITY_HEARTBEAT_MS,
  AUTHORITY_LEASE_MS,
  QUOTA_LOCK,
  readNostrDbAuthority,
  withNostrDbAuthority
} from '#services/idb/nostrdb/authority.js'

function storageWith (lease) {
  const values = new Map()
  if (lease) values.set(NOSTRDB_AUTHORITY_KEY, JSON.stringify(lease))
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  }
}

function lockHarness (available) {
  const calls = []
  let first = true
  return {
    calls,
    locks: {
      request (name, options, callback) {
        calls.push({ name, options })
        if (first) {
          first = false
          return Promise.resolve(callback(options.ifAvailable ? (available ? { name } : null) : { name }))
        }
        return Promise.resolve(callback({ name }))
      }
    }
  }
}

it('acquires immediately and records quota lock timing', async () => {
  const storage = storageWith()
  const { locks, calls } = lockHarness(true)
  const timings = []
  const result = await withNostrDbAuthority(async authority => {
    assert.equal(authority.generation, 1)
    assert.equal(authority.signal.aborted, false)
    assert.equal(readNostrDbAuthority(storage).leaseUntil > 0, true)
    return 'complete'
  }, entry => timings.push(entry), {
    locks,
    storage,
    now: () => 1_000,
    replicaId: 'tab-a'
  })

  assert.equal(result, 'complete')
  assert.deepEqual(calls, [{ name: QUOTA_LOCK, options: { ifAvailable: true } }])
  assert.equal(readNostrDbAuthority(storage).leaseUntil, 0)
  assert.deepEqual(timings.map(entry => entry.stage), ['quota-lock-wait', 'quota-lock-execution'])
})

it('waits normally for an active lease and retains the legacy lock name', async () => {
  const storage = storageWith({
    version: 1,
    generation: 4,
    instanceId: 'tab-a',
    leaseUntil: 5_000,
    updatedAt: 1_000
  })
  const { locks, calls } = lockHarness(false)
  const result = await withNostrDbAuthority(authority => authority.generation, undefined, {
    locks,
    storage,
    now: () => 2_000,
    replicaId: 'tab-b'
  })

  assert.equal(result, 5)
  assert.deepEqual(calls[0], { name: QUOTA_LOCK, options: { ifAvailable: true } })
  assert.equal(calls[1].name, QUOTA_LOCK)
  assert.equal(calls[1].options.signal instanceof AbortSignal, true)
  assert.equal(calls[1].options.steal, undefined)
})

it('steals after lease expiry even when waiter arrived while the lease was still active', async () => {
  const storage = storageWith({
    version: 1,
    generation: 4,
    instanceId: 'tab-a',
    leaseUntil: 5_000,
    updatedAt: 1_000
  })
  let clock = 2_000
  const calls = []
  const timers = []
  const locks = {
    request (name, options, callback) {
      calls.push({ name, options })
      if (options.ifAvailable) return Promise.resolve(callback(null))
      if (options.steal) return Promise.resolve(callback({ name }))
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(options.signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }))
        }, { once: true })
      })
    }
  }

  const pending = withNostrDbAuthority(authority => authority.generation, undefined, {
    locks,
    storage,
    now: () => clock,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref () {} }
      timers.push(timer)
      return timer
    },
    clearTimer: timer => { if (timer) timer.cleared = true },
    replicaId: 'tab-b'
  })

  await Promise.resolve()
  await Promise.resolve()
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delay, 3_000)

  // Frozen tab A never renewed; when the bounded wait timer fires at t=5000, tab B steals.
  clock = 5_000
  timers[0].callback()
  assert.equal(await pending, 5)
  assert.equal(calls.some(call => call.options?.steal === true), true)
})

it('does not steal a legacy holder that has no persisted lease', async () => {
  const storage = storageWith()
  const { locks, calls } = lockHarness(false)
  await withNostrDbAuthority(() => {}, undefined, {
    locks,
    storage,
    now: () => 2_000,
    replicaId: 'tab-b'
  })

  assert.deepEqual(calls[1], { name: QUOTA_LOCK, options: {} })
})

it('steals only an expired active lease, not a completed one or its own lease', async () => {
  for (const lease of [
    { instanceId: 'tab-a', generation: 1, leaseUntil: 1_999 },
    { instanceId: 'tab-a', generation: 1, leaseUntil: 0 }
  ]) {
    const storage = storageWith({
      version: 1,
      generation: lease.generation,
      instanceId: lease.instanceId,
      leaseUntil: lease.leaseUntil,
      updatedAt: 1_000
    })
    const { locks, calls } = lockHarness(false)
    await withNostrDbAuthority(() => {}, undefined, {
      locks,
      storage,
      now: () => 2_000,
      replicaId: 'tab-b'
    })
    assert.deepEqual(calls[1], {
      name: QUOTA_LOCK,
      options: lease.leaseUntil > 0 ? { steal: true } : {}
    })
  }

  const ownStorage = storageWith({
    version: 1,
    generation: 7,
    instanceId: 'tab-b',
    leaseUntil: 1_999,
    updatedAt: 1_000
  })
  const own = lockHarness(false)
  await withNostrDbAuthority(() => {}, undefined, {
    locks: own.locks,
    storage: ownStorage,
    now: () => 2_000,
    replicaId: 'tab-b'
  })
  assert.deepEqual(own.calls[1], { name: QUOTA_LOCK, options: {} })
})

it('renews its lease while the operation is running', async () => {
  const storage = storageWith()
  const { locks } = lockHarness(true)
  const timers = []
  let clock = 1_000
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const running = withNostrDbAuthority(async authority => {
    entered.resolve(authority)
    await finish.promise
    return 'done'
  }, undefined, {
    locks,
    storage,
    now: () => clock,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref () {} }
      timers.push(timer)
      return timer
    },
    clearTimer: timer => { timer.cleared = true },
    heartbeatMs: AUTHORITY_HEARTBEAT_MS,
    leaseMs: AUTHORITY_LEASE_MS,
    replicaId: 'tab-a'
  })

  const authority = await entered.promise
  assert.equal(timers.at(-1).delay, AUTHORITY_HEARTBEAT_MS)
  assert.equal(readNostrDbAuthority(storage).leaseUntil, 31_000)
  clock = 11_000
  timers.at(-1).callback()
  assert.equal(readNostrDbAuthority(storage).leaseUntil, 41_000)
  assert.equal(readNostrDbAuthority(storage).generation, authority.generation)

  finish.resolve()
  assert.equal(await running, 'done')
  assert.equal(readNostrDbAuthority(storage).leaseUntil, 0)
  assert.equal(timers.at(-1).cleared, true)
})

it('aborts and rejects the old generation after another context takes authority', async () => {
  const storage = storageWith()
  const { locks } = lockHarness(true)
  const timers = []
  const clock = 1_000
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const running = withNostrDbAuthority(async authority => {
    entered.resolve(authority)
    await finish.promise
  }, undefined, {
    locks,
    storage,
    now: () => clock,
    setTimer: callback => {
      const timer = { callback, unref () {} }
      timers.push(timer)
      return timer
    },
    clearTimer: () => {},
    replicaId: 'tab-a'
  })

  const authority = await entered.promise
  storage.setItem(NOSTRDB_AUTHORITY_KEY, JSON.stringify({
    version: 1,
    generation: authority.generation + 1,
    instanceId: 'tab-b',
    leaseUntil: 60_000,
    updatedAt: clock
  }))
  const aborted = new Promise(resolve => authority.signal.addEventListener('abort', resolve, { once: true }))
  timers[0].callback()
  await aborted
  assert.equal(authority.signal.reason.code, 'NOSTRDB_AUTHORITY_LOST')
  finish.resolve()
  await assert.rejects(running, { code: 'NOSTRDB_AUTHORITY_LOST' })
})

it('treats its unrefreshed expired lease as lost before completing or heartbeating', async () => {
  const storage = storageWith()
  const { locks } = lockHarness(true)
  let clock = 1_000
  async function run () {
    return withNostrDbAuthority(authority => {
      clock = 31_001
      assert.throws(authority.assertLeader, { code: 'NOSTRDB_AUTHORITY_LOST' })
    }, undefined, {
      locks,
      storage,
      now: () => clock,
      replicaId: 'tab-a'
    })
  }

  await assert.rejects(run(), { code: 'NOSTRDB_AUTHORITY_LOST' })
  assert.equal(readNostrDbAuthority(storage).leaseUntil, 31_000)
})
