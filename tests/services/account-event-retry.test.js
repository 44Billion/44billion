import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAccountEventRetry } from '../../src/services/account-event-retry.js'

const flush = async () => { for (let n = 0; n < 3; n++) await new Promise(resolve => setImmediate(resolve)) }
const remote = message => Object.assign(new Error(message), { category: 'relay' })
const interrupted = () => Object.assign(new Error('disconnected'), { category: 'transport' })

function fixture (t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 })
  const controller = new AbortController()
  const state = { online: true, checks: 0, monitors: 0, stopped: 0 }
  let wake
  const policy = createAccountEventRetry({
    signal: controller.signal, random: () => 0.5,
    checkOnline: async () => { state.checks++; return state.online },
    watchOnline: handler => { state.monitors++; wake = handler; return () => { state.stopped++; wake = null } }
  })
  t.after(() => controller.abort())
  return {
    state, controller,
    wait: (error, delay = 1000, source = 'relay', signal = controller.signal) => policy.wait(error, { delay, source, signal }),
    online () { state.online = true; wake?.() },
    async advance (ms) { await flush(); t.mock.timers.tick(ms); await flush() }
  }
}

test('definitive, unknown and local authentication read failures never enter automatic retry', async t => {
  const f = fixture(t)
  for (const message of ['blocked: denied', 'restricted: denied', 'auth-required: sign in', 'pow: 20', 'invalid: filter', 'unknown']) {
    assert.equal(await f.wait(remote(message)), null)
  }
  assert.equal(await f.wait(Object.assign(remote('error: auth failed'), { name: 'Nip42AuthenticationError' })), null)
  assert.equal(await f.wait(Object.assign(interrupted(), { name: 'ValidationError' })), null)
  assert.equal(f.state.checks, 0)
  assert.equal(f.state.monitors, 0)
})

test('retry_after and local backoff compete as absolute deadlines and reconnection cannot bypass either', async t => {
  const f = fixture(t)
  let finished = false
  const first = f.wait(Object.assign(remote('rate-limited: busy'), { retryAt: 15000, retryAfterMs: 5000 })).then(value => { finished = true; return value })
  await f.advance(1000)
  f.online(); await flush()
  await f.advance(3999)
  assert.equal(finished, false)
  await f.advance(1)
  assert.equal(await first, 2000)
  finished = false
  const second = f.wait(Object.assign(remote('rate-limited: busy'), { retryAt: 15500 }), 2000).then(value => { finished = true; return value })
  await f.advance(1999)
  assert.equal(finished, false)
  await f.advance(1)
  assert.equal(await second, 4000)
  assert.equal(f.state.checks, 0, 'a structured relay response does not probe internet')
})

test('offline waiters share connectivity, preserve backoff and release independently', async t => {
  const f = fixture(t)
  f.state.online = false
  const departing = new AbortController()
  const first = f.wait(interrupted(), 1000, 'relay', departing.signal)
  const second = f.wait(interrupted())
  await flush()
  assert.equal(f.state.checks, 1)
  assert.equal(f.state.monitors, 1)
  departing.abort()
  assert.equal(await first, null)
  assert.equal(f.state.stopped, 0)
  await f.advance(600000)
  f.online(); await flush()
  assert.equal(await second, 1000, 'offline never spends the first delay')
  assert.equal(f.state.stopped, 1)
  let finished = false
  const resumed = f.wait(interrupted()).then(value => { finished = true; return value })
  await f.advance(999)
  assert.equal(finished, false)
  await f.advance(1)
  assert.equal(await resumed, 2000)
})

test('going offline during backoff holds the attempt without another increment', async t => {
  const f = fixture(t)
  let finished = false
  const wait = f.wait(interrupted()).then(value => { finished = true; return value })
  await flush()
  f.state.online = false
  await f.advance(1000)
  assert.equal(finished, false)
  await f.advance(600000)
  f.online(); await flush()
  assert.equal(await wait, 2000)
})

test('storage and local queue recovery are independent of relay classification and internet', async t => {
  const f = fixture(t)
  f.state.online = false
  const storage = f.wait(Object.assign(remote('blocked: database quota'), { retryAt: 300000 }), 1000, 'storage')
  const admission = f.wait(Object.assign(new Error('RELAY_READ_QUEUE_FULL'), { code: 'RELAY_READ_QUEUE_FULL' }), 1000, 'local-read')
  await f.advance(1000)
  assert.equal(await storage, 2000)
  assert.equal(await admission, 2000)
  assert.equal(f.state.checks, 0)
  assert.equal(f.state.monitors, 0)
  assert.equal(await f.wait(Object.assign(new Error('capacity'), { code: 'RELAY_READ_CAPACITY' }), 1000, 'local-read'), null)
})

test('account retry remains capped at thirty seconds and cancellation frees deadline waits', async t => {
  const f = fixture(t)
  let finished = false
  const wait = f.wait(remote('error: busy'), 30000).then(value => { finished = true; return value })
  await f.advance(29999)
  assert.equal(finished, false)
  await f.advance(1)
  assert.equal(await wait, 30000)
  const cancelled = f.wait(Object.assign(remote('rate-limited: busy'), { retryAt: 600000 }))
  f.controller.abort()
  assert.equal(await cancelled, null)
})

test('known browser offline pauses local read recovery while storage recovery remains available', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator })
  const f = fixture(t)
  let readFinished = false
  const queue = f.wait(Object.assign(new Error('queue'), { code: 'RELAY_READ_QUEUE_FULL' }), 1000, 'local-read').then(value => { readFinished = true; return value })
  const storage = f.wait(new Error('quota'), 1000, 'storage')
  await f.advance(1000)
  assert.equal(await storage, 2000)
  assert.equal(readFinished, false)
  assert.equal(f.state.checks, 0)
  assert.equal(f.state.monitors, 1)
  globalThis.navigator.onLine = true
  f.online(); await flush()
  assert.equal(await queue, 1000)
})
