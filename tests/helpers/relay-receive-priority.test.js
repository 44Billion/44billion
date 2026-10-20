import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createControlPriority } from '#services/relay-pool/receive-priority.js'
import { createBridgeReceiveQueue } from '#services/relay-pool/bridge-receive-queue.js'
import { RELAY_POOL_LIMITS } from '#services/relay-pool/constants.js'

const publication = (id, kind = 3560) => ['EVENT', { id, kind, sig: 'sig', tags: [] }]

test('receive preference correlates publications, auth, counts and active sessions', () => {
  const policy = createControlPriority()
  for (const frame of [['OK', 'unknown', true, ''], ['CLOSED', 'unknown', 'closed:'], ['EOSE', 'unknown'], ['COUNT', 'unknown', { count: 1 }], ['NEG-MSG', 'unknown', 'aa'], ['NEG-ERR', 'unknown', 'closed:']]) assert.equal(policy.take(frame).priority, 0)
  policy.note(publication('private'))
  policy.note(publication('public', 9))
  policy.note(['AUTH', { ...publication('auth')[1], kind: 22242 }])
  assert.equal(policy.take(['OK', 'private', false, 'rate-limited:', '@20000']).priority, 2)
  assert.equal(policy.take(['OK', 'private', true, '']).priority, 0)
  assert.equal(policy.take(['OK', 'public', true, '']).priority, 1)
  assert.equal(policy.take(['OK', 'auth', true, '']).priority, 2)
  assert.equal(policy.take(['AUTH', 'challenge']).priority, 2)
  policy.note(['REQ', 'same', {}])
  policy.note(['NEG-OPEN', 'same', {}, 'aa'])
  policy.note(['COUNT', 'count', {}])
  assert.deepEqual(policy.take(['EOSE', 'same']), { priority: 1, stream: 'sub:same' })
  assert.deepEqual(policy.take(['EVENT', 'same', {}]), { priority: 0, stream: 'sub:same' })
  assert.deepEqual(policy.take(['NEG-MSG', 'same', 'bb']), { priority: 1, stream: 'neg:same' })
  assert.equal(policy.take(['COUNT', 'count', { count: 2 }]).priority, 1)
  assert.equal(policy.take(['COUNT', 'count', { count: 2 }]).priority, 0)
  assert.equal(policy.take(['CLOSED', 'same', 'closed:', '@20000']).priority, 1)
  assert.equal(policy.take(['EOSE', 'same']).priority, 0)
  assert.equal(policy.take(['NEG-ERR', 'same', 'closed:']).priority, 1)
  assert.equal(policy.take(['NEG-MSG', 'same', 'cc']).priority, 0)
})

test('cancellation, malformed replies, bounded hints and teardown retain safe defaults', () => {
  const policy = createControlPriority()
  for (let i = 0; i < 257; i++) policy.note(publication(String(i)))
  assert.equal(policy.take(['OK', '0', true, '']).priority, 0)
  assert.equal(policy.take(['OK', '256', true, '']).priority, 2)
  policy.note(['REQ', 'sub', {}]); policy.note(['CLOSE', 'sub'])
  policy.note(['NEG-OPEN', 'neg', {}, 'aa']); policy.note(['NEG-CLOSE', 'neg'])
  assert.equal(policy.take(['EOSE', 'sub']).priority, 0)
  assert.equal(policy.take(['NEG-ERR', 'neg', 'closed:']).priority, 0)
  policy.note(publication('malformed'))
  assert.equal(policy.take(['OK', 'malformed', 'true', '']).priority, 0)
  assert.equal(policy.take(['OK', 'malformed', true, '']).priority, 2)
  policy.note(['REQ', 'sub', {}]); policy.note(['COUNT', 'count', {}]); policy.note(['NEG-OPEN', 'neg', {}, 'aa'])
  policy.clear()
  assert.equal(policy.take(['EOSE', 'sub']).priority, 0)
  assert.equal(policy.take(['COUNT', 'count', {}]).priority, 0)
  assert.equal(policy.take(['NEG-MSG', 'neg', 'bb']).priority, 0)
  assert.equal(policy.take('not json').priority, 0)
})

function fixture (t, limits = {}) {
  const sent = []
  const receive = createBridgeReceiveQueue({ endpointId: 'three-level', virtualId: 'one', owner: 'app', relay: 'relay', limits: { ...RELAY_POOL_LIMITS, bridgeReceiveCreditFrames: 1, bridgeReceiveCreditBytes: 256, ...limits }, onFrame: (data, through) => sent.push({ data, through }), onClose: () => assert.fail('unexpected close'), onOverflow: () => assert.fail('unexpected overflow') })
  t.after(receive.close)
  const push = frame => receive.push(JSON.stringify(frame))
  const note = frame => receive.noteOutgoing(JSON.stringify(frame))
  const grant = () => {
    const last = sent.at(-1)
    receive.grant({ frames: 1, bytes: last.data.length, through: last.through })
  }
  const drain = () => { while (receive.snapshot().pendingFrames) grant() }
  push(['NOTICE', 'holding credit'])
  return { receive, sent, push, note, grant, drain, frames: () => sent.slice(1).map(item => JSON.parse(item.data)) }
}

test('controls bypass unrelated history but preserve EVENT/EOSE/CLOSED and NEG session order', t => {
  const f = fixture(t)
  for (const id of ['a', 'b', 'empty']) f.note(['REQ', id, {}])
  f.note(['NEG-OPEN', 'neg', {}, 'aa'])
  f.push(['EVENT', 'a', {}]); f.push(['EOSE', 'a'])
  f.push(['EVENT', 'b', {}]); f.push(['CLOSED', 'b', 'closed:'])
  f.push(['CLOSED', 'empty', 'closed:'])
  f.push(['NEG-MSG', 'neg', 'bb']); f.push(['NEG-ERR', 'neg', 'closed:'])
  f.note(publication('urgent')); f.push(['OK', 'urgent', true, ''])
  f.drain()
  const frames = f.frames().map(frame => `${frame[0]}:${frame[1]}`)
  assert.deepEqual(frames, ['OK:urgent', 'CLOSED:empty', 'NEG-MSG:neg', 'EVENT:a', 'EOSE:a', 'NEG-ERR:neg', 'EVENT:b', 'CLOSED:b'])
  assert.equal(f.receive.heldBytes, 0)
})

test('three receive classes get weighted service without starving normal traffic', t => {
  const f = fixture(t)
  for (let i = 0; i < 20; i++) {
    f.note(publication(`h${i}`)); f.push(['OK', `h${i}`, true, ''])
    f.note(publication(`m${i}`, 1)); f.push(['OK', `m${i}`, true, ''])
    f.push(['NOTICE', `n${i}`])
  }
  f.drain()
  assert.deepEqual(f.frames().slice(0, 16).map(frame => frame[1][0]), ['h', 'h', 'h', 'm', 'h', 'h', 'h', 'm', 'h', 'h', 'h', 'n', 'h', 'h', 'h', 'm'])
  for (const prefix of ['h', 'm', 'n']) assert.deepEqual(f.frames().filter(frame => frame[1].startsWith(prefix)).map(frame => frame[1]), Array.from({ length: 20 }, (_, i) => `${prefix}${i}`))
})

test('a live EVENT cannot pass its own queued EOSE when intermediate credit is unavailable', t => {
  const f = fixture(t)
  f.note(['REQ', 'live', {}])
  f.push(['EOSE', 'live']); f.push(['EVENT', 'live', {}])
  f.drain()
  assert.deepEqual(f.frames().map(frame => frame[0]), ['EOSE', 'EVENT'])
})

test('large NEG responses stay normal and their terminal error cannot overtake them', t => {
  const f = fixture(t)
  f.note(['NEG-OPEN', 'same', {}, 'aa'])
  f.note(['REQ', 'same', {}])
  f.push(['NEG-MSG', 'same', 'a'.repeat(17000)])
  f.push(['NEG-ERR', 'same', 'closed:'])
  f.push(['EOSE', 'same'])
  f.drain()
  assert.deepEqual(f.frames().map(frame => frame[0]), ['EOSE', 'NEG-MSG', 'NEG-ERR'])
})

test('reused subscription IDs keep already queued results before the new terminator', t => {
  const f = fixture(t)
  f.note(['REQ', 'same', {}]); f.push(['EVENT', 'same', {}])
  f.note(['CLOSE', 'same']); f.note(['REQ', 'same', {}]); f.push(['EOSE', 'same'])
  f.drain()
  assert.deepEqual(f.frames().map(frame => frame[0]), ['EVENT', 'EOSE'])
})

test('a due normal frame accumulates credit instead of starving behind smaller controls', t => {
  const sent = []
  const receive = createBridgeReceiveQueue({ endpointId: 'partial-refunds', virtualId: 'one', owner: 'app', relay: 'relay', limits: { ...RELAY_POOL_LIMITS, bridgeReceiveCreditFrames: 20, bridgeReceiveCreditBytes: 1000 }, onFrame: (data, through) => sent.push({ data, through }), onClose: () => assert.fail('unexpected close'), onOverflow: () => assert.fail('unexpected overflow') })
  t.after(receive.close)
  receive.push('x'.repeat(1000))
  const normal = JSON.stringify(['EVENT', 'history', { content: 'x'.repeat(800) }])
  receive.push(normal)
  for (let i = 0; i < 20; i++) {
    receive.noteOutgoing(publication(`h${i}`)); receive.push(JSON.stringify(['OK', `h${i}`, true, '']))
    receive.noteOutgoing(publication(`m${i}`, 1)); receive.push(JSON.stringify(['OK', `m${i}`, true, '']))
  }
  receive.grant({ frames: 1, bytes: 1000, through: 1 })
  assert.equal(sent.length, 12, 'nine high and two intermediate admissions precede the due normal turn')
  const outstanding = sent.slice(1)
  receive.grant({ frames: outstanding.length, bytes: outstanding.reduce((sum, item) => sum + item.data.length, 0), through: outstanding.at(-1).through })
  assert.equal(sent[12].data, normal)
})
