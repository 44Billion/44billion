import assert from 'node:assert/strict'
import { it } from 'node:test'
import { UnifiedRelayPool } from '#services/relay-pool/pool.js'
import { RELAY_POOL_LIMITS } from '#services/relay-pool/constants.js'

const A = 'wss://relay.example/a'
const B = 'wss://relay.example/b'
const flush = async () => { for (let n = 0; n < 4; n++) await new Promise(resolve => setImmediate(resolve)) }

class Socket {
  readyState = 0
  sent = []
  open () { this.readyState = 1; this.onopen?.() }
  fail (code = 1006) { this.readyState = 3; this.onclose?.({ code, reason: 'native closure', wasClean: code !== 1006 }) }
  close () { this.readyState = 3 }
  send (raw) { this.sent.push(JSON.parse(raw)) }
  message (frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}

function fixture (t, overrides = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 })
  const state = { online: true, navOnline: true, checks: 0, signals: [], listeners: new Set(), sockets: [], random: 0.5 }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine')
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => state.navOnline })
  const pool = new UnifiedRelayPool({
    limits: { ...RELAY_POOL_LIMITS, maxNewConnectionsPerSecond: 100, maxNewConnectionsPerWindow: 100, ...overrides },
    _random: () => state.random,
    _isOnline: options => { state.checks++; state.signals.push(options.signal); return state.probe ?? Promise.resolve(state.online) },
    _onOnline: callback => { state.listeners.add(callback); return () => state.listeners.delete(callback) },
    createSocket: url => {
      if (state.createError) throw state.createError
      const socket = new Socket(); socket.url = url; state.sockets.push(socket); return socket
    }
  })
  t.after(() => {
    pool.closeAll()
    if (descriptor) Object.defineProperty(globalThis.navigator, 'onLine', descriptor)
    else delete globalThis.navigator.onLine
  })
  return {
    pool, state,
    row: (url = A) => pool.snapshot().connectionRecovery.urls.find(row => row.relay === url),
    attach: async (url = A, handlers = {}) => { const member = pool.attach(url, handlers); await flush(); return member },
    advance: async ms => { t.mock.timers.tick(ms); await flush() },
    online: async () => { state.online = state.navOnline = true; for (const callback of [...state.listeners]) callback(); await flush() }
  }
}

it('shares exponential absolute deadlines across consumers and caps jitter at 30 seconds', async t => {
  const f = fixture(t)
  await f.attach()
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const failedAt = Date.now()
    f.state.sockets.at(-1).fail()
    const a = await f.attach()
    assert.equal(f.row().retryAt, failedAt + delay)
    const deadline = f.row().retryAt
    const count = f.state.sockets.length
    const b = await f.attach()
    await f.online()
    assert.equal(f.row().retryAt, deadline)
    await f.advance(delay - 1)
    assert.equal(f.state.sockets.length, count)
    await f.advance(1)
    assert.equal(f.state.sockets.length, count + 1, 'all interested consumers share the recovery socket')
    a.close(); b.close()
    // Cancelling the trial consumes no stage; another request keeps this epoch.
    await f.attach()
  }
})

it('samples jitter once and remounts preserve an existing deadline', async t => {
  const f = fixture(t)
  f.state.random = 1
  await f.attach()
  f.state.sockets[0].fail()
  const waiting = await f.attach()
  assert.equal(f.row().retryAt, 101200)
  waiting.close()
  f.state.random = 0
  await f.advance(500)
  await f.attach()
  assert.equal(f.row().retryAt, 101200)
  await f.advance(700)
  assert.equal(f.state.sockets.length, 2)
  f.state.sockets[1].fail()
  await f.attach()
  assert.equal(f.row().retryAt, 102800)
})

it('open does not reset a flapping connection; thirty seconds of stability does', async t => {
  const f = fixture(t)
  await f.attach(); f.state.sockets[0].fail()
  await f.attach(); await f.advance(1000)
  f.state.sockets[1].open()
  await f.advance(29999)
  assert.equal(f.row().nextDelayMs, 2000)
  f.state.sockets[1].fail()
  await f.attach()
  assert.equal(f.row().nextDelayMs, 4000)
  await f.advance(2000)
  f.state.sockets[2].open()
  await f.advance(30000)
  assert.equal(f.row().nextDelayMs, 1000)
  f.state.sockets[2].fail()
  await f.attach()
  assert.equal(f.row().retryAt, Date.now() + 1000)
})

it('ignores failures with healthy siblings and groups simultaneous native failures into one stage', async t => {
  const f = fixture(t, { maxSubscriptionsPerBucket: 1 })
  const a = await f.attach(); f.state.sockets[0].open()
  a.send('["REQ","a",{}]')
  const b = await f.attach()
  b.send('["REQ","b",{}]'); await flush()
  assert.equal(f.state.sockets.length, 2)
  f.state.sockets[1].fail()
  const c = await f.attach()
  assert.equal(f.row().nextDelayMs, 1000)
  assert.equal(f.state.checks, 0)
  c.send('["REQ","c",{}]'); await flush()
  f.state.sockets[2].open()
  f.state.sockets[0].fail(); f.state.sockets[2].fail()
  await f.attach()
  assert.equal(f.row().nextDelayMs, 2000)
  assert.equal(f.state.checks, 1)
})

it('one recovery trial excludes another bucket until open, then existing connection budgets apply', async t => {
  const f = fixture(t, { maxSubscriptionsPerBucket: 1 })
  await f.attach(); f.state.sockets[0].fail()
  const a = await f.attach()
  a.send('["REQ","a",{}]')
  const b = await f.attach()
  b.send('["REQ","b",{}]'); await flush()
  await f.advance(1000)
  assert.equal(f.state.sockets.length, 2)
  assert.equal(f.row().trial, true)
  f.state.sockets[1].open(); await flush()
  assert.equal(f.state.sockets.length, 3)
})

it('different paths and hosts do not wait behind a delayed destination', async t => {
  const f = fixture(t)
  await f.attach(); f.state.sockets[0].fail()
  await f.attach()
  await f.attach(B)
  await f.attach('wss://other.example')
  assert.deepEqual(f.state.sockets.map(socket => socket.url), [A, B, 'wss://other.example'])
})

it('offline consumes no stage, shares one monitor and preserves prior deadlines on recovery', async t => {
  const f = fixture(t)
  await f.attach(); f.state.sockets[0].fail()
  const waiting = await f.attach()
  const deadline = f.row().retryAt
  f.state.navOnline = false
  await f.attach(B)
  await f.advance(500)
  assert.equal(f.state.listeners.size, 1)
  assert.equal(f.state.sockets.length, 1)
  await f.online()
  assert.equal(f.row().retryAt, deadline)
  assert.equal(f.state.sockets.length, 2, 'other URL resumes independently')
  await f.advance(500)
  assert.equal(f.state.sockets.length, 3)
  f.state.online = false
  f.state.sockets.at(-1).fail()
  await f.attach()
  assert.equal(f.row().nextDelayMs, 2000)
  await f.advance(30000)
  assert.equal(f.state.sockets.length, 3)
  waiting.close()
  await f.online()
  assert.equal(f.state.sockets.length, 4)
  assert.equal(f.state.listeners.size, 0)
})

it('concurrent failure checks share a probe and cancel its signal when no consumers remain', async t => {
  const f = fixture(t)
  await f.attach(); await f.attach(B)
  f.state.sockets.forEach(socket => socket.fail())
  let finish
  f.state.probe = new Promise(resolve => { finish = resolve })
  const a = await f.attach()
  const b = await f.attach(B)
  assert.equal(f.state.checks, 1)
  a.close(); b.close(); await flush()
  assert.equal(f.state.signals[0].aborted, true)
  finish(true); await flush()
  assert.equal(f.row().nextDelayMs, 1000)
})

it('handshake timeout belongs to the native attempt, not the backoff queue', async t => {
  const f = fixture(t)
  const closes = []
  await f.attach(A, { onClose: info => closes.push(info) })
  await f.advance(9999)
  assert.deepEqual(closes, [])
  await f.advance(1)
  assert.equal(closes[0].reason, 'relay connection timeout')
  assert.equal(f.pool.snapshot().failureDiagnostics.byCode.RELAY_SOCKET_CONNECT_TIMEOUT, 1)
  assert.equal(f.pool.snapshot().failureDiagnostics.byCode.RELAY_BRIDGE_ATTACH_TIMEOUT, undefined)
  await f.attach()
  await f.advance(1000)
  assert.equal(f.state.sockets.length, 2)
  await f.advance(9999)
  assert.equal(f.pool.snapshot().failureDiagnostics.byCode.RELAY_SOCKET_CONNECT_TIMEOUT, 1)
})

for (const code of [1000, 1002, 1003, 1007, 1008, 1009, 1010, 4000]) {
  it(`native code ${code} keeps its diagnostic without advancing physical backoff`, async t => {
    const f = fixture(t)
    await f.attach(); f.state.sockets[0].fail(code)
    await f.attach()
    assert.equal(f.state.sockets.length, 2)
    assert.equal(f.state.checks, 0)
    assert.equal(f.row().recovering, false)
  })
}

it('rate advice, local overflow and consumer reports never advance physical backoff', async t => {
  const f = fixture(t, { messageBudgetPerRelay: 1, maxQueuedFramesPerMember: 1 })
  const a = await f.attach(); f.state.sockets[0].open()
  a.send('["REQ","a",{}]'); await flush()
  f.state.sockets[0].message(['CLOSED', f.state.sockets[0].sent[0][1], 'rate-limited: busy', { retry_after: 10 }])
  a.send('["REQ","b",{}]'); a.send('["REQ","c",{}]')
  f.pool.recordConsumerFailure(A, { code: 1006 })
  const b = await f.attach()
  assert.equal(f.row().recovering, false)
  assert.equal(f.row().nextDelayMs, 1000)
  assert.equal(f.state.checks, 0)
  b.close()
})

it('send failures are recoverable but last-consumer cancellation is not', async t => {
  const f = fixture(t)
  const a = await f.attach(); f.state.sockets[0].open()
  f.state.sockets[0].send = () => { throw new Error('native send failed') }
  a.send('["REQ","a",{}]'); await flush()
  const waiting = await f.attach()
  assert.equal(f.row().retryAt, Date.now() + 1000)
  waiting.close(); await f.advance(1000)
  assert.equal(f.state.sockets.length, 1)
  const first = await f.attach()
  const second = await f.attach()
  first.close()
  assert.equal(f.state.sockets[1].readyState, 0)
  second.close()
  assert.equal(f.state.sockets[1].readyState, 3)
  assert.equal(f.pool.snapshot().connectionRecovery.cancelledBeforeOpen, 2)
  assert.equal(f.row().nextDelayMs, 2000)
})

it('idle recovery expires after five minutes and late checks cannot update a new pool generation', async t => {
  const f = fixture(t)
  await f.attach(); f.state.sockets[0].fail()
  const waiting = await f.attach()
  waiting.close()
  await f.advance(299999)
  assert.ok(f.row())
  await f.advance(1)
  assert.equal(f.row(), undefined)
  await f.attach(); f.state.sockets.at(-1).fail()
  let finish
  f.state.probe = new Promise(resolve => { finish = resolve })
  await f.attach()
  f.pool.closeAll()
  assert.equal(f.pool.snapshot().connectionRecovery.urls.length, 0)
  finish(true); await flush()
  await f.attach()
  assert.equal(f.row().recovering, false)
})

it('the build switch disables recovery waits and probes', async t => {
  const f = fixture(t, { physicalBackoffEnabled: false })
  await f.attach(); f.state.sockets[0].fail()
  await f.attach()
  assert.equal(f.state.sockets.length, 2)
  assert.equal(f.state.checks, 0)
})

for (const code of [1001, 1005, 1006, 1011, 1012, 1013, 1014, 1015]) {
  it(`observed native code ${code} starts one physical recovery stage`, async t => {
    const f = fixture(t)
    await f.attach(); f.state.sockets[0].fail(code)
    await f.attach()
    assert.equal(f.row().retryAt, 101000)
    assert.equal(f.row().nextDelayMs, 2000)
  })
}

it('connectivity verification does not add its duration to the absolute backoff', async t => {
  const f = fixture(t)
  await f.attach(); f.state.sockets[0].fail()
  let finish
  f.state.probe = new Promise(resolve => { finish = resolve })
  await f.attach(); await f.advance(3000)
  finish(true); await flush()
  assert.equal(f.row().retryAt, 101000)
  assert.equal(f.state.sockets.length, 2)
})

it('a successful sibling invalidates a pending failure check without hiding its subsequent failure', async t => {
  const f = fixture(t, { maxSubscriptionsPerBucket: 1 })
  const a = await f.attach()
  a.send('["REQ","a",{}]')
  const b = await f.attach()
  b.send('["REQ","b",{}]'); await flush()
  f.state.sockets[0].fail()
  let finish
  f.state.probe = new Promise(resolve => { finish = resolve })
  await f.attach()
  f.state.sockets[1].open()
  finish(false); await flush()
  assert.equal(f.pool.snapshot().connectionRecovery.offline, false)
  f.state.probe = null
  f.state.sockets[1].fail()
  for (const socket of f.state.sockets) if (socket.readyState < 2) socket.fail()
  await f.attach()
  await flush()
  assert.equal(f.row().retryAt, 101000)
})

it('construction failures remain local and snapshot details stay bounded and detached', async t => {
  const f = fixture(t)
  f.state.createError = new Error('invalid native construction')
  await f.attach()
  assert.equal(f.pool.snapshot().failureDiagnostics.byCode.RELAY_SOCKET_CREATE_FAILED, 1)
  assert.equal(f.row().recovering, false)
  assert.equal(f.state.checks, 0)
  f.state.createError = null
  for (let index = 0; index < 40; index++) await f.attach(`wss://relay-${index}.example`)
  const snapshot = f.pool.snapshot().connectionRecovery
  assert.equal(snapshot.urls.length, 32)
  snapshot.urls[0].retryAt = 123456
  assert.equal(f.pool.snapshot().connectionRecovery.urls[0].retryAt, 0)
})
