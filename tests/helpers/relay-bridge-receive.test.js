import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createBridgeReceiveQueue } from '#services/relay-pool/bridge-receive-queue.js'
import { RELAY_POOL_LIMITS } from '#services/relay-pool/constants.js'

function fixture (t, options = {}) {
  const sent = []
  const closed = []
  const overflows = []
  const receive = createBridgeReceiveQueue({
    endpointId: 1, virtualId: 'one', owner: 'app', relay: 'wss://test.example', limits: RELAY_POOL_LIMITS, ...options,
    onFrame: (data, sequence) => sent.push({ data, sequence }), onClose: (code, reason) => closed.push({ code, reason }), onOverflow: value => overflows.push(value)
  })
  t.after(receive.close)
  return { receive, sent, closed, overflows }
}

it('absorbs the reported vault burst while its consumer returns no credits', t => {
  const f = fixture(t)
  for (let index = 0; index < 82; index++) f.receive.push('x'.repeat(17 * 1024))
  const state = f.receive.snapshot()
  assert.equal(state.pendingFrames + state.queuedFrames, 82)
  assert.equal(f.closed.length, 0)
  assert.ok(state.pendingBytes <= 1024 * 1024)
  assert.ok(state.queuedBytes < 4 * 1024 * 1024)
  while (f.receive.snapshot().pendingFrames) {
    const snapshot = f.receive.snapshot()
    f.receive.grant({ frames: snapshot.pendingFrames, bytes: snapshot.pendingBytes })
  }
  assert.equal(f.sent.length, 82)
  assert.equal(f.receive.heldBytes, 0)
})

it('sends a larger frame alone without allowing EOSE to bypass it', t => {
  const f = fixture(t)
  const first = 'a'.repeat(768 * 1024)
  const large = 'b'.repeat(2 * 1024 * 1024)
  f.receive.push(first)
  f.receive.push(large)
  f.receive.push('EOSE')
  assert.equal(f.sent.length, 1)
  f.receive.grant({ frames: 1, bytes: first.length, through: 1 })
  assert.equal(f.sent.length, 2)
  assert.equal(f.receive.snapshot().credit.bytes, -1024 * 1024)
  f.receive.grant({ frames: 1, bytes: large.length, through: 2 })
  assert.deepEqual(f.sent.map(item => item.data), [first, large, 'EOSE'])
})

it('rejects oversized frames immediately without retaining them', t => {
  const f = fixture(t)
  f.receive.push('x'.repeat(4 * 1024 * 1024 + 1))
  assert.equal(f.closed[0].reason, 'relay bridge frame too large')
  assert.equal(f.overflows[0].scope, 'frame')
  assert.equal(f.receive.heldBytes, 0)
})

for (const scope of ['endpoint', 'tab']) {
  for (const unit of ['frames', 'bytes']) {
    it(`counts in-flight credit against the ${scope} ${unit} budget and releases the largest connection`, t => {
      const limits = {
        ...RELAY_POOL_LIMITS, bridgeReceiveCreditBytes: 200,
        [scope === 'endpoint' ? 'bridgeEndpointBytes' : 'bridgeTotalBytes']: unit === 'bytes' ? 100 : 1000,
        [scope === 'endpoint' ? 'bridgeEndpointFrames' : 'bridgeTotalFrames']: unit === 'frames' ? 3 : 100
      }
      const a = fixture(t, { limits })
      const b = fixture(t, { limits, endpointId: scope === 'tab' ? 2 : 1, virtualId: 'two' })
      a.receive.push('x'.repeat(40))
      a.receive.push('x'.repeat(40))
      b.receive.push('x'.repeat(10))
      b.receive.push('x'.repeat(20))
      assert.equal(a.overflows[0].scope, scope)
      assert.deepEqual(a.overflows[0].exceeded, [unit])
      assert.equal(a.receive.heldBytes, 0)
      assert.equal(b.closed.length, 0)
      assert.equal(b.sent.length, 2)
    })
  }
}

it('measures credit round trips and optional cross-context stages', t => {
  let clock = 0
  const f = fixture(t, { now: () => clock, epochNow: () => 1000 + clock })
  f.receive.push('frame')
  clock = 30
  assert.equal(f.receive.snapshot().oldestPendingMs, 30)
  f.receive.grant({ frames: 1, bytes: 5, through: 1, receivedAt: 1010, returnedAt: 1020 })
  assert.deepEqual(f.receive.snapshot().latency, {
    roundTrip: { count: 1, lastMs: 30, maxMs: 30 }, delivery: { count: 1, lastMs: 10, maxMs: 10 },
    consumer: { count: 1, lastMs: 10, maxMs: 10 }, return: { count: 1, lastMs: 10, maxMs: 10 }
  })
  f.receive.push('legacy')
  clock = 35
  f.receive.grant({ frames: 1, bytes: 6 })
  assert.equal(f.receive.snapshot().latency.roundTrip.count, 2)
  assert.equal(f.receive.snapshot().latency.consumer.count, 1)
})

for (const payload of [{ frames: 2, bytes: 5 }, { frames: 1, bytes: 500 }, { frames: -1, bytes: 5 }, { frames: 1, bytes: 5, through: 99 }]) {
  it(`rejects invalid credit ${JSON.stringify(payload)}`, t => {
    const f = fixture(t)
    f.receive.push('frame')
    f.receive.grant(payload)
    assert.equal(f.closed[0].reason, 'invalid relay bridge credit')
    assert.equal(f.receive.heldBytes, 0)
  })
}

it('rejects replayed credit even when another equal-sized frame is pending', t => {
  const f = fixture(t)
  f.receive.push('frame')
  const credit = { frames: 1, bytes: 5, through: 1 }
  f.receive.grant(credit)
  f.receive.push('other')
  f.receive.grant(credit)
  assert.equal(f.closed[0].reason, 'invalid relay bridge credit')
})
