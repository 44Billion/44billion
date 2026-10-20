import { it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createQuotaScheduler, quotaBlocks, quotaNeedsAttention, quotaTotalKeys,
  publishQuotaState, readQuotaState, reloadQuotaState, resetQuotaStateMemory
} from '#services/idb/nostrdb/quota-state.js'
import { NOSTRDB_QUOTA_STATE_KEY } from '#constants/storage-schema.js'

afterEach(resetQuotaStateMemory)
const limits = { publicBytes: 100, privateBytes: 100, cacheBytes: 100, cacheCount: 10 }
const totals = Object.fromEntries(quotaTotalKeys.map(key => [key, 0]))

function clock (review) {
  let time = 0
  let id = 0
  const timers = new Map()
  const starts = []
  const scheduler = createQuotaScheduler({
    now: () => time,
    setTimer: (fn, ms) => { timers.set(++id, { fn, at: time + ms }); return id },
    clearTimer: id => timers.delete(id),
    review: async () => { starts.push(time); return review?.() ?? {} }
  })
  return {
    scheduler, starts,
    async advance (ms) {
      for (let i = 0; i < 8; i++) await Promise.resolve()
      const end = time + ms
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > end) break
        time = next[1].at
        timers.delete(next[0])
        next[1].fn()
        for (let i = 0; i < 8; i++) await Promise.resolve()
      }
      time = end
    }
  }
}

it('coalesces commits without postponing the first deadline and idles for one minute', async () => {
  const c = clock()
  c.scheduler.wake({ count: 1 })
  await c.advance(800)
  c.scheduler.wake({ count: 1 })
  await c.advance(200)
  assert.deepEqual(c.starts, [1000])
  await c.advance(59999)
  assert.equal(c.starts.length, 1)
  await c.advance(1)
  assert.deepEqual(c.starts, [1000, 61000])
  c.scheduler.stop()
})

it('expedites at 64 mutations or 4 MiB, with a 250ms minimum between starts', async () => {
  const c = clock()
  c.scheduler.wake({ count: 64 })
  await c.advance(0)
  assert.deepEqual(c.starts, [0])
  c.scheduler.wake({ volume: 4 * 1024 * 1024 })
  await c.advance(249)
  assert.equal(c.starts.length, 1)
  await c.advance(1)
  assert.deepEqual(c.starts, [0, 250])
  c.scheduler.stop()
})

it('retains demands accepted during a running review without overlapping work', async () => {
  const held = Promise.withResolvers()
  let calls = 0
  const c = clock(() => ++calls === 1 ? held.promise : {})
  await c.advance(1000)
  c.scheduler.wake({ count: 64 })
  await c.advance(500)
  assert.equal(c.starts.length, 1)
  held.resolve({})
  await c.advance(0)
  await c.advance(0)
  assert.deepEqual(c.starts, [1000, 1500])
  c.scheduler.stop()
})

it('preserves capped backoff despite new demands and resets it after success', async () => {
  let failing = true
  const c = clock(() => { if (failing) throw new Error('storage unavailable'); return {} })
  await c.advance(1000)
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = c.starts.length
    c.scheduler.wake({ immediate: true })
    await c.advance(delay - 1)
    assert.equal(c.starts.length, before)
    await c.advance(1)
    assert.equal(c.starts.length, before + 1)
  }
  failing = false
  await c.advance(30000)
  const before = c.starts.length
  c.scheduler.wake({ immediate: true })
  await c.advance(250)
  assert.equal(c.starts.length, before + 1)
  c.scheduler.stop()
})

it('retries cache excess each second and cancels timers on stop', async () => {
  const c = clock(() => ({ excess: true }))
  await c.advance(3000)
  assert.deepEqual(c.starts, [1000, 2000, 3000])
  c.scheduler.stop()
  await c.advance(60000)
  assert.equal(c.starts.length, 3)
})

it('respects a retry deadline shared by another context despite urgent new writes', async () => {
  let first = true
  const c = clock(() => {
    if (first) { first = false; return { deferMs: 30000 } }
    return {}
  })
  await c.advance(1000)
  c.scheduler.wake({ immediate: true })
  await c.advance(29999)
  assert.deepEqual(c.starts, [1000])
  await c.advance(1)
  assert.deepEqual(c.starts, [1000, 31000])
  c.scheduler.stop()
})

it('keeps categories independent, allows unknown positive budgets, and always disables zero budgets', () => {
  assert.deepEqual(quotaBlocks(null, limits), { public: false, private: false, cache: false })
  assert.deepEqual(quotaBlocks({ ...totals, privateBytes: 101, cacheCount: 11 }, limits), { public: false, private: true, cache: true })
  assert.deepEqual(quotaBlocks(null, { ...limits, publicBytes: 0, cacheCount: 0 }), { public: true, private: false, cache: true })
})

it('publishes only durable revisions, ignores old notifications, and preserves the last success during failure', t => {
  const storage = new Map()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage })
  const input = { ...totals }
  const configured = { ...limits }
  const first = publishQuotaState({ totals: input, limits: configured, checkedAt: 10 })
  input.privateBytes = 999
  configured.privateBytes = 0
  assert.equal(readQuotaState().totals.privateBytes, 0)
  assert.equal(readQuotaState().limits.privateBytes, 100)
  const second = publishQuotaState({ limits, maintenance: { failed: true } })
  assert.equal(second.checkedAt, 10)
  assert.deepEqual(second.totals, totals)
  assert.ok(second.revision > first.revision)
  storage.set(NOSTRDB_QUOTA_STATE_KEY, JSON.stringify(first))
  assert.equal(reloadQuotaState().revision, second.revision)
  t.mock.method(localStorage, 'setItem', () => { throw new Error('disk full') })
  assert.throws(() => publishQuotaState({ totals: { ...totals, privateBytes: 101 }, limits }))
  assert.deepEqual(readQuotaState(), second)
  const exposed = readQuotaState()
  exposed.totals.privateBytes = 999
  assert.equal(readQuotaState().totals.privateBytes, 0)
})

it('alerts for retained-category excess and cache failure, without alerting for normal cache cleanup', () => {
  const state = { totals: { ...totals, cacheBytes: 101 }, limits, maintenance: { cacheAttention: false } }
  assert.equal(quotaNeedsAttention(state), false)
  assert.equal(quotaNeedsAttention({ ...state, maintenance: { cacheAttention: true } }), true)
  assert.equal(quotaNeedsAttention({ ...state, totals: { ...totals, publicBytes: 101 } }), true)
  assert.equal(quotaNeedsAttention({ ...state, limits: { ...limits, cacheBytes: 200 }, maintenance: { cacheAttention: true } }), false, 'raising the limit clears stale cache attention immediately')
})
