import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { finalizeEvent } from 'libp2r2p/event'
import { generateSecretKey } from 'libp2r2p/key'

import { closeCodeLabel } from '#services/relay-pool/close-code-label.js'
import { RELAY_POOL_LIMITS } from '#services/relay-pool/constants.js'
import { UnifiedRelayPool } from '#services/relay-pool/pool.js'
import { RelayRegistry } from '#services/relay-pool/registry.js'

class FakeSocket {
  constructor (url) {
    this.url = url
    this.sent = []
    this.readyState = 0
    this.extensions = ''
    this.closed = null
  }

  open () {
    this.readyState = 1
    this.onopen?.()
  }

  send (raw) {
    this.sent.push(JSON.parse(raw))
  }

  close (code, reason) {
    this.readyState = 3
    this.closed = { code, reason }
  }

  message (value) {
    this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) })
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

function authEvent (secretKey, { challenge, relay = 'wss://relay.example' }) {
  return finalizeEvent({
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['relay', relay], ['challenge', challenge]],
    content: ''
  }, secretKey)
}

function createPool (overrides = {}, { log = () => {} } = {}) {
  const sockets = []
  const pool = new UnifiedRelayPool({
    createSocket: url => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    registry: new RelayRegistry(),
    limits: {
      ...RELAY_POOL_LIMITS,
      maxNewConnectionsPerSecond: 100,
      maxNewConnectionsPerWindow: 100,
      bucketIdleMs: 20,
      ...overrides
    },
    log
  })
  return { pool, sockets }
}

async function setupTwoAuthBucketsWithNeg ({ pool, sockets, alice, handlersA = {}, handlersB = {} }) {
  const memberA = pool.attach('wss://relay.example', handlersA)
  await tick()
  sockets[0].open()
  await tick()
  sockets[0].message(['AUTH', 'c0'])
  const authA = authEvent(alice, { challenge: 'c0' })
  memberA.send(JSON.stringify(['AUTH', authA]))
  await tick()
  sockets[0].message(['OK', authA.id, true, ''])
  await tick()
  memberA.send(JSON.stringify(['REQ', 'a', { kinds: [1] }]))
  await tick()

  const memberB = pool.attach('wss://relay.example', handlersB)
  await tick()
  sockets[1].open()
  await tick()
  sockets[1].message(['AUTH', 'c1'])
  memberB.send(JSON.stringify(['NEG-OPEN', 'negB', { kinds: [1] }, 'bb']))
  await tick()
  const nsNegB = sockets[1].sent.find(message => message[0] === 'NEG-OPEN')[1]
  sockets[1].message(['NEG-MSG', nsNegB, 'payload'])
  await tick()
  memberB.send(JSON.stringify(['REQ', 'b', { kinds: [1] }]))
  await tick()
  const authB = authEvent(alice, { challenge: 'c1' })
  memberB.send(JSON.stringify(['AUTH', authB]))
  await tick()
  sockets[1].message(['OK', authB.id, true, ''])
  await tick()
  return { memberA, memberB, nsNegB }
}

function signedEvent (pubkey = 'p'.repeat(64)) {
  return {
    id: `${pubkey.slice(0, 8)}${Date.now()}`.padEnd(64, '0'),
    pubkey,
    sig: 's'.repeat(128),
    kind: 1,
    created_at: 1,
    tags: [],
    content: 'hello'
  }
}

describe('unified relay pool', () => {
  it('labels WebSocket close codes', () => {
    assert.equal(closeCodeLabel(1000), 'normal closure')
    assert.equal(closeCodeLabel(1006), 'abnormal closure (no close frame)')
    assert.equal(closeCodeLabel(1013), 'try again later')
    assert.equal(closeCodeLabel(4321), 'code 4321')
    assert.equal(closeCodeLabel(undefined), 'unknown')
  })

  it('shares one physical socket and namespaces subscription ids', async () => {
    const { pool, sockets } = createPool()
    const a = []
    const b = []
    const memberA = pool.attach('wss://relay.example', { onOpen: () => a.push('open'), onMessage: raw => a.push(JSON.parse(raw)) })
    const memberB = pool.attach('wss://relay.example', { onOpen: () => b.push('open'), onMessage: raw => b.push(JSON.parse(raw)) })
    await tick()
    assert.equal(sockets.length, 1)
    sockets[0].open()
    await tick()
    assert.deepEqual(a[0], 'open')
    assert.deepEqual(b[0], 'open')

    memberA.send(JSON.stringify(['REQ', 'sub1', { kinds: [1] }]))
    memberB.send(JSON.stringify(['REQ', 'sub1', { kinds: [1] }]))
    await tick()
    const requests = sockets[0].sent.filter(message => message[0] === 'REQ')
    assert.equal(requests.length, 2)
    assert.notEqual(requests[0][1], requests[1][1])
    assert.ok(requests.every(request => request[1].includes('sub1')))

    const event = signedEvent()
    sockets[0].message(['EVENT', requests[0][1], event])
    await tick()
    assert.deepEqual(a.at(-1), ['EVENT', 'sub1', event])
    assert.equal(b.some(item => Array.isArray(item) && item[0] === 'EVENT'), false)
  })

  it('replaces a subscription when the client reuses the same raw id', async () => {
    const { pool, sockets } = createPool()
    const member = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    member.send(JSON.stringify(['REQ', 'feed', { kinds: [1] }]))
    await tick()
    member.send(JSON.stringify(['REQ', 'feed', { kinds: [2] }]))
    await tick()
    const requests = sockets[0].sent.filter(message => message[0] === 'REQ')
    assert.equal(requests.length, 2)
    assert.equal(requests[0][1], requests[1][1])
    assert.deepEqual(requests[1][2], { kinds: [2] })
    assert.equal(pool.snapshot().subscriptions, 1)
  })

  it('applies new-connection budgets per host instead of globally', async () => {
    const { pool, sockets } = createPool({ maxNewConnectionsPerSecond: 1, maxNewConnectionsPerWindow: 1 })
    pool.attach('wss://a.example', {})
    pool.attach('wss://b.example', {})
    await tick()
    assert.equal(sockets.length, 2)
  })

  it('opens a pending member when a shared bucket frees a subscription slot', async () => {
    const { pool, sockets } = createPool({ maxSubscriptionsPerBucket: 1, maxBucketsPerRelay: 1 })
    const opens = []
    const memberA = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    memberA.send(JSON.stringify(['REQ', 'a', { kinds: [1] }]))
    await tick()
    pool.attach('wss://relay.example', { onOpen: () => opens.push('b') })
    await tick()
    assert.deepEqual(opens, [])
    memberA.send(JSON.stringify(['CLOSE', 'a']))
    await tick()
    assert.deepEqual(opens, ['b'])
    assert.equal(pool.snapshot().pendingMembers, 0)
  })

  it('reports bucket, subscription and drop diagnostics in the snapshot', async () => {
    const { pool, sockets } = createPool()
    const member = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    member.send(JSON.stringify(['REQ', 'sub1', { kinds: [1] }]))
    await tick()
    sockets[0].message(['EVENT', 'unknown-sub', { id: 'x' }])
    await tick()
    const snapshot = pool.snapshot()
    assert.equal(snapshot.subscriptions, 1)
    assert.equal(snapshot.bucketsByHost['relay.example'], 1)
    assert.equal(snapshot.droppedByOp.EVENT, 1)
  })

  it('attributes members and subscriptions by owner', async () => {
    const { pool, sockets } = createPool()
    const vaultMember = pool.attach('wss://relay.example', {}, { owner: 'vault' })
    const appMember = pool.attach('wss://relay.example', {}, { owner: 'app' })
    await tick()
    sockets[0].open()
    await tick()
    vaultMember.send(JSON.stringify(['REQ', 'v', { kinds: [1] }]))
    appMember.send(JSON.stringify(['REQ', 'a', { kinds: [1] }]))
    await tick()
    const snapshot = pool.snapshot()
    assert.deepEqual(snapshot.membersByOwner, { vault: 1, app: 1 })
    assert.deepEqual(snapshot.subscriptionsByOwner, { vault: 1, app: 1 })
  })

  it('counts late CLOSED confirmations instead of drops', async () => {
    const { pool, sockets } = createPool()
    const member = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    member.send(JSON.stringify(['REQ', 'a', { kinds: [1] }]))
    await tick()
    const nsId = sockets[0].sent.find(message => message[0] === 'REQ')[1]
    member.send(JSON.stringify(['CLOSE', 'a']))
    await tick()
    sockets[0].message(['CLOSED', nsId, 'closed by client'])
    await tick()
    const snapshot = pool.snapshot()
    assert.equal(snapshot.closedConfirmations, 1)
    assert.equal(snapshot.droppedByOp.CLOSED, undefined)
  })

  it('records relay connection failures in the snapshot', async () => {
    const { pool, sockets } = createPool()
    pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].onclose?.({ code: 1006, reason: 'boom' })
    await tick()
    const snapshot = pool.snapshot()
    assert.equal(snapshot.connectionFailures, 1)
    const failure = snapshot.relayFailures['wss://relay.example']
    assert.equal(failure.lastCode, 1006)
    assert.equal(failure.lastCodeLabel, 'abnormal closure (no close frame)')
    assert.equal(failure.lastReason, 'boom')
    assert.equal(failure.lastPhase, 'pool')
    assert.equal(failure.lastWasClean, false)
    assert.ok(failure.lastOpenedAt > 0)
    assert.ok(failure.lastLifetimeMs >= 0)
  })

  it('logs failures without an embedded prefix and with a reason placeholder', async () => {
    const logs = []
    const { pool, sockets } = createPool({}, { log: (...args) => logs.push(args) })
    pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].onclose?.({ code: 1006, reason: '' })
    await tick()
    const failureLog = logs.find(args => args[0] === 'connection failed')
    assert.deepEqual(failureLog, ['connection failed', 'wss://relay.example', 1006, '<none>', 'pool'])
  })

  it('sends CLOSE for the relay when a virtual socket closes and keeps the other member alive', async () => {
    const { pool, sockets } = createPool()
    const memberA = pool.attach('wss://relay.example', {})
    const memberB = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    memberA.send(JSON.stringify(['REQ', 'a', { kinds: [1] }]))
    memberB.send(JSON.stringify(['REQ', 'b', { kinds: [1] }]))
    await tick()
    const nsA = sockets[0].sent.find(message => message[0] === 'REQ' && message[1].includes(':a'))[1]
    memberA.close(1000, '')
    await tick()
    assert.deepEqual(sockets[0].sent.at(-1), ['CLOSE', nsA])
    assert.equal(pool.snapshot().members, 1)
    assert.equal(sockets[0].closed, null)
  })

  it('routes OK only to the publishers and deduplicates repeated OKs', async () => {
    const { pool, sockets } = createPool()
    const a = []
    const b = []
    const memberA = pool.attach('wss://relay.example', { onMessage: raw => a.push(JSON.parse(raw)) })
    pool.attach('wss://relay.example', { onMessage: raw => b.push(JSON.parse(raw)) })
    await tick()
    sockets[0].open()
    await tick()
    const event = signedEvent()
    memberA.send(JSON.stringify(['EVENT', event]))
    await tick()
    sockets[0].message(['OK', event.id, true, 'saved'])
    sockets[0].message(['OK', event.id, true, 'saved'])
    await tick()
    assert.deepEqual(a, [['OK', event.id, true, 'saved']])
    assert.deepEqual(b, [])
  })

  it('delivers a fresh OK when the same event is published again after acceptance or rejection', async t => {
    for (const firstAccepted of [true, false]) {
      const { pool, sockets } = createPool()
      t.after(() => pool.closeAll())
      const received = []
      const member = pool.attach('wss://relay.example', { onMessage: raw => received.push(JSON.parse(raw)) })
      await tick()
      sockets[0].open()
      await tick()
      const event = signedEvent()
      member.send(JSON.stringify(['EVENT', event]))
      await tick()
      sockets[0].message(['OK', event.id, firstAccepted, firstAccepted ? 'saved' : 'auth-required: authenticate'])
      await tick()
      member.send(JSON.stringify(['EVENT', event]))
      await tick()
      sockets[0].message(['OK', event.id, true, 'saved on retry'])
      sockets[0].message(['OK', event.id, true, 'duplicate response'])
      await tick()
      assert.deepEqual(received, [
        ['OK', event.id, firstAccepted, firstAccepted ? 'saved' : 'auth-required: authenticate'],
        ['OK', event.id, true, 'saved on retry']
      ], 'each publication attempt receives its acknowledgement; unsolicited repeats stay suppressed')
    }
  })

  it('distinguishes queued publications from sent frames awaiting OK and logs slow responses without content', async t => {
    const logs = []
    const { pool, sockets } = createPool({ slowPublicationMs: 0 }, { log: (...args) => logs.push(args) })
    t.after(() => pool.closeAll())
    const member = pool.attach('wss://relay.example', {}, { owner: 'app' })
    await tick()
    sockets[0].open()
    await tick()
    const event = { ...signedEvent(), content: 'private ciphertext' }
    member.send(JSON.stringify(['EVENT', event]))
    const queued = pool.snapshot().pendingPublicationsByRelay['wss://relay.example']
    assert.equal(queued.queued, 1)
    assert.equal(queued.awaitingOk, 0)
    await tick()
    const sent = pool.snapshot().pendingPublicationsByRelay['wss://relay.example']
    assert.equal(sent.queued, 0)
    assert.equal(sent.awaitingOk, 1)
    assert.ok(sent.oldestMs >= 0)
    sockets[0].message(['OK', event.id, true, 'saved'])
    assert.deepEqual(pool.snapshot().pendingPublicationsByRelay, {})
    assert.equal(pool.snapshot().slowPublicationResponses, 1)
    const [label, response] = logs.at(-1)
    assert.equal(label, 'slow publication response')
    assert.equal(response.relay, 'wss://relay.example')
    assert.equal(response.eventId, event.id)
    assert.equal(response.owner, 'app')
    assert.equal(response.accepted, true)
    assert.equal(response.reason, 'saved')
    assert.ok(response.queueMs >= 0)
    assert.ok(response.responseMs >= 0)
    assert.equal(response.elapsedMs, response.queueMs + response.responseMs)
    assert.equal(JSON.stringify(logs).includes(event.content), false)
  })

  it('replays pending publication records after a bucket move and removes them on close', async t => {
    const { pool, sockets } = createPool({ maxSubscriptionsPerBucket: 1 })
    t.after(() => pool.closeAll())
    const received = []
    const a = pool.attach('wss://relay.example', {})
    const b = pool.attach('wss://relay.example', { onMessage: raw => received.push(JSON.parse(raw)) })
    await tick()
    sockets[0].open()
    await tick()
    a.send(JSON.stringify(['REQ', 'a', { kinds: [1] }]))
    const event = signedEvent()
    b.send(JSON.stringify(['EVENT', event]))
    await tick()
    b.send(JSON.stringify(['REQ', 'b', { kinds: [1] }]))
    await tick()
    assert.equal(sockets.length, 2)
    assert.equal(pool.snapshot().pendingPublicationsByRelay['wss://relay.example'].queued, 1)
    sockets[1].open()
    await tick()
    assert.deepEqual(sockets[1].sent.find(frame => frame[0] === 'EVENT'), ['EVENT', event])
    sockets[1].message(['OK', event.id, true, 'saved'])
    assert.deepEqual(received.filter(frame => frame[0] === 'OK'), [['OK', event.id, true, 'saved']])
    assert.deepEqual(pool.snapshot().pendingPublicationsByRelay, {})
    b.send(JSON.stringify(['EVENT', event]))
    b.close(1000, '')
    assert.deepEqual(pool.snapshot().pendingPublicationsByRelay, {})
  })

  it('delivers the relay OK for AUTH and confirms the identity only after OK true', async () => {
    const { pool, sockets } = createPool()
    const received = []
    const member = pool.attach('wss://relay.example', { onMessage: raw => received.push(JSON.parse(raw)) })
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].message(['AUTH', 'challenge-normal'])
    const event = authEvent(generateSecretKey(), { challenge: 'challenge-normal' })
    member.send(JSON.stringify(['AUTH', event]))
    await tick()
    assert.equal(sockets[0].sent.some(message => message[0] === 'AUTH' && message[1].id === event.id), true)
    sockets[0].message(['OK', event.id, true, ''])
    await tick()
    assert.deepEqual(received.at(-1), ['OK', event.id, true, ''])
    assert.equal(pool.snapshot().pendingAuths, undefined)
  })

  it('swaps the authenticating member to its own bucket and migrates the others', async () => {
    const { pool, sockets } = createPool()
    const memberA = pool.attach('wss://relay.example', {})
    const memberB = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    memberA.send(JSON.stringify(['REQ', 'a', { kinds: [1] }]))
    memberB.send(JSON.stringify(['REQ', 'b', { kinds: [1] }]))
    await tick()
    sockets[0].message(['AUTH', 'challenge-swap'])
    const event = authEvent(generateSecretKey(), { challenge: 'challenge-swap' })
    memberA.send(JSON.stringify(['AUTH', event]))
    await tick()
    assert.equal(sockets.length, 2)
    assert.equal(sockets[0].sent.some(message => message[0] === 'AUTH' && message[1].id === event.id), true)
    sockets[1].open()
    await tick()
    assert.equal(sockets[1].sent.some(message => message[0] === 'REQ' && message[1].includes(':b')), true)
    assert.equal(pool.snapshot().authSwaps, 1)
    assert.equal(pool.snapshot().migrations, 1)
  })

  it('merges a second socket into the confirmed bucket with a synthetic OK', async () => {
    const { pool, sockets } = createPool()
    const alice = generateSecretKey()
    const memberA = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].message(['AUTH', 'c0'])
    const firstAuth = authEvent(alice, { challenge: 'c0' })
    memberA.send(JSON.stringify(['AUTH', firstAuth]))
    await tick()
    sockets[0].message(['OK', firstAuth.id, true, ''])
    await tick()

    const received = []
    const memberB = pool.attach('wss://relay.example', { onMessage: raw => received.push(JSON.parse(raw)) })
    await tick()
    assert.equal(sockets.length, 2)
    sockets[1].open()
    await tick()
    sockets[1].message(['AUTH', 'c1'])
    memberB.send(JSON.stringify(['REQ', 'sub-b', { kinds: [1] }]))
    await tick()
    const secondAuth = authEvent(alice, { challenge: 'c1' })
    memberB.send(JSON.stringify(['AUTH', secondAuth]))
    await tick()
    assert.equal(sockets[1].sent.some(message => message[0] === 'AUTH'), false)
    assert.equal(received.some(message => message[0] === 'OK' && message[1] === secondAuth.id && message[2] === true), true)
    assert.equal(pool.snapshot().authMerges, 1)
    assert.equal(sockets[0].sent.some(message => message[0] === 'REQ' && message[1].includes('sub-b')), true)
  })

  it('rejects an invalid AUTH locally with OK false and never forwards it', async () => {
    const { pool, sockets } = createPool()
    const received = []
    const member = pool.attach('wss://relay.example', { onMessage: raw => received.push(JSON.parse(raw)) })
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].message(['AUTH', 'right-challenge'])
    const event = authEvent(generateSecretKey(), { challenge: 'wrong-challenge' })
    member.send(JSON.stringify(['AUTH', event]))
    await tick()
    assert.equal(sockets[0].sent.some(message => message[0] === 'AUTH'), false)
    assert.deepEqual(received.at(-1), ['OK', event.id, false, 'invalid: AUTH challenge'])
    assert.equal(pool.snapshot().authRejected, 1)
  })

  it('authenticates a non-mergeable anonymous socket in place as a second bucket', async () => {
    const { pool, sockets } = createPool()
    const alice = generateSecretKey()
    const memberA = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].message(['AUTH', 'c0'])
    const firstAuth = authEvent(alice, { challenge: 'c0' })
    memberA.send(JSON.stringify(['AUTH', firstAuth]))
    await tick()
    sockets[0].message(['OK', firstAuth.id, true, ''])
    await tick()

    const closed = []
    const memberB = pool.attach('wss://relay.example', { onClose: info => closed.push(info) })
    await tick()
    sockets[1].open()
    await tick()
    sockets[1].message(['AUTH', 'c1'])
    memberB.send(JSON.stringify(['NEG-OPEN', 'neg1', { kinds: [1] }, 'aa']))
    await tick()
    const nsNeg = sockets[1].sent.find(message => message[0] === 'NEG-OPEN')[1]
    sockets[1].message(['NEG-MSG', nsNeg, 'payload'])
    await tick()
    const secondAuth = authEvent(alice, { challenge: 'c1' })
    memberB.send(JSON.stringify(['AUTH', secondAuth]))
    await tick()
    assert.deepEqual(closed, [])
    assert.equal(sockets[1].sent.some(message => message[0] === 'AUTH' && message[1].id === secondAuth.id), true)
    sockets[1].message(['OK', secondAuth.id, true, ''])
    await tick()
    assert.equal(pool.snapshot().authMerges, 0)
    assert.equal(pool.snapshot().subscriptions, 0)
  })

  it('reconnects a client that authenticates as another pubkey on an authenticated bucket', async () => {
    const { pool, sockets } = createPool()
    const alice = generateSecretKey()
    const bob = generateSecretKey()
    const closed = []
    const member = pool.attach('wss://relay.example', { onClose: info => closed.push(info) })
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].message(['AUTH', 'c0'])
    const authP = authEvent(alice, { challenge: 'c0' })
    member.send(JSON.stringify(['AUTH', authP]))
    await tick()
    sockets[0].message(['OK', authP.id, true, ''])
    await tick()
    const authQ = authEvent(bob, { challenge: 'c0' })
    member.send(JSON.stringify(['AUTH', authQ]))
    await tick()
    assert.equal(closed.at(-1).code, 1006)
    assert.equal(sockets[0].sent.some(message => message[0] === 'AUTH' && message[1].id === authQ.id), false)
    assert.equal(pool.snapshot().authReconnects, 1)
  })

  it('allows a second authenticated bucket when the confirmed one has no room', async () => {
    const { pool, sockets } = createPool({ maxSubscriptionsPerBucket: 1 })
    const alice = generateSecretKey()
    const memberA = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].message(['AUTH', 'c0'])
    const firstAuth = authEvent(alice, { challenge: 'c0' })
    memberA.send(JSON.stringify(['AUTH', firstAuth]))
    await tick()
    sockets[0].message(['OK', firstAuth.id, true, ''])
    await tick()
    memberA.send(JSON.stringify(['REQ', 'a', { kinds: [1] }]))
    await tick()

    const closed = []
    const memberB = pool.attach('wss://relay.example', { onClose: info => closed.push(info) })
    await tick()
    sockets[1].open()
    await tick()
    sockets[1].message(['AUTH', 'c1'])
    memberB.send(JSON.stringify(['REQ', 'b', { kinds: [1] }]))
    await tick()
    const secondAuth = authEvent(alice, { challenge: 'c1' })
    memberB.send(JSON.stringify(['AUTH', secondAuth]))
    await tick()
    assert.deepEqual(closed, [])
    assert.equal(sockets[1].sent.some(message => message[0] === 'AUTH' && message[1].id === secondAuth.id), true)
    sockets[1].message(['OK', secondAuth.id, true, ''])
    await tick()
    assert.equal(pool.snapshot().authMerges, 0)
    assert.equal(pool.snapshot().subscriptions, 2)
  })

  it('consolidates two authenticated buckets when a subscription slot frees', async () => {
    const { pool, sockets } = createPool({ maxSubscriptionsPerBucket: 1 })
    const alice = generateSecretKey()
    const memberA = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].message(['AUTH', 'c0'])
    const authA = authEvent(alice, { challenge: 'c0' })
    memberA.send(JSON.stringify(['AUTH', authA]))
    await tick()
    sockets[0].message(['OK', authA.id, true, ''])
    await tick()
    memberA.send(JSON.stringify(['REQ', 'a', { kinds: [1] }]))
    await tick()

    const memberB = pool.attach('wss://relay.example', {})
    await tick()
    sockets[1].open()
    await tick()
    sockets[1].message(['AUTH', 'c1'])
    memberB.send(JSON.stringify(['REQ', 'b', { kinds: [1] }]))
    await tick()
    const authB = authEvent(alice, { challenge: 'c1' })
    memberB.send(JSON.stringify(['AUTH', authB]))
    await tick()
    sockets[1].message(['OK', authB.id, true, ''])
    await tick()
    assert.equal(pool.snapshot().buckets, 2)

    memberA.send(JSON.stringify(['CLOSE', 'a']))
    await tick()
    assert.equal(pool.snapshot().consolidations, 1)
    assert.equal(sockets[0].sent.some(message => message[0] === 'REQ' && message[1].includes('b')), true)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(pool.snapshot().buckets, 1)
  })

  it('waits for NEG-CLOSE before consolidating a connection-bound member', async () => {
    const { pool, sockets } = createPool()
    const alice = generateSecretKey()
    const memberA = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].message(['AUTH', 'c0'])
    const authA = authEvent(alice, { challenge: 'c0' })
    memberA.send(JSON.stringify(['AUTH', authA]))
    await tick()
    sockets[0].message(['OK', authA.id, true, ''])
    await tick()
    memberA.send(JSON.stringify(['NEG-OPEN', 'negA', { kinds: [1] }, 'aa']))
    await tick()
    const nsNegA = sockets[0].sent.find(message => message[0] === 'NEG-OPEN')[1]
    sockets[0].message(['NEG-MSG', nsNegA, 'payload'])
    await tick()
    memberA.send(JSON.stringify(['REQ', 'a', { kinds: [1] }]))
    await tick()

    const memberB = pool.attach('wss://relay.example', {})
    await tick()
    sockets[1].open()
    await tick()
    sockets[1].message(['AUTH', 'c1'])
    memberB.send(JSON.stringify(['NEG-OPEN', 'negB', { kinds: [1] }, 'bb']))
    await tick()
    const nsNegB = sockets[1].sent.find(message => message[0] === 'NEG-OPEN')[1]
    sockets[1].message(['NEG-MSG', nsNegB, 'payload'])
    await tick()
    memberB.send(JSON.stringify(['REQ', 'b', { kinds: [1] }]))
    await tick()
    const authB = authEvent(alice, { challenge: 'c1' })
    memberB.send(JSON.stringify(['AUTH', authB]))
    await tick()
    sockets[1].message(['OK', authB.id, true, ''])
    await tick()
    assert.equal(pool.snapshot().buckets, 2)

    memberA.send(JSON.stringify(['CLOSE', 'a']))
    await tick()
    assert.equal(pool.snapshot().consolidations, 0)
    assert.equal(sockets[0].sent.some(message => message[0] === 'REQ' && message[1].includes(':b')), false)

    memberB.send(JSON.stringify(['NEG-CLOSE', 'negB']))
    await tick()
    assert.equal(pool.snapshot().consolidations, 1)
    assert.equal(sockets[0].sent.some(message => message[0] === 'REQ' && message[1].includes(':b')), true)
  })

  it('does not consolidate when the target cannot hold the member subscriptions', async () => {
    const { pool, sockets } = createPool({ maxSubscriptionsPerBucket: 2 })
    const alice = generateSecretKey()
    const memberA = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].message(['AUTH', 'c0'])
    const authA = authEvent(alice, { challenge: 'c0' })
    memberA.send(JSON.stringify(['AUTH', authA]))
    await tick()
    sockets[0].message(['OK', authA.id, true, ''])
    await tick()
    memberA.send(JSON.stringify(['REQ', 'a1', { kinds: [1] }]))
    memberA.send(JSON.stringify(['REQ', 'a2', { kinds: [1] }]))
    await tick()

    const memberB = pool.attach('wss://relay.example', {})
    await tick()
    sockets[1].open()
    await tick()
    sockets[1].message(['AUTH', 'c1'])
    memberB.send(JSON.stringify(['REQ', 'b1', { kinds: [1] }]))
    memberB.send(JSON.stringify(['REQ', 'b2', { kinds: [1] }]))
    await tick()
    const authB = authEvent(alice, { challenge: 'c1' })
    memberB.send(JSON.stringify(['AUTH', authB]))
    await tick()
    sockets[1].message(['OK', authB.id, true, ''])
    await tick()

    memberA.send(JSON.stringify(['CLOSE', 'a1']))
    await tick()
    assert.equal(pool.snapshot().consolidations, 0)
    assert.equal(pool.snapshot().buckets, 2)
  })

  it('consolidates two anonymous buckets when a subscription slot frees', async () => {
    const { pool, sockets } = createPool({ maxSubscriptionsPerBucket: 1 })
    const memberA = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    memberA.send(JSON.stringify(['REQ', 'a', { kinds: [1] }]))
    await tick()
    const memberB = pool.attach('wss://relay.example', {})
    await tick()
    assert.equal(sockets.length, 2)
    sockets[1].open()
    await tick()
    memberB.send(JSON.stringify(['REQ', 'b', { kinds: [1] }]))
    await tick()

    memberA.send(JSON.stringify(['CLOSE', 'a']))
    await tick()
    assert.equal(pool.snapshot().consolidations, 1)
    assert.equal(sockets[0].sent.some(message => message[0] === 'REQ' && message[1].includes('b')), true)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(pool.snapshot().buckets, 1)
  })

  it('keeps pending-AUTH buckets out of anonymous consolidation and placement', async () => {
    const { pool, sockets } = createPool({ maxSubscriptionsPerBucket: 2 })
    const alice = generateSecretKey()
    const memberA = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    memberA.send(JSON.stringify(['REQ', 'a1', { kinds: [1] }]))
    memberA.send(JSON.stringify(['REQ', 'a2', { kinds: [1] }]))
    await tick()

    const memberB = pool.attach('wss://relay.example', {})
    await tick()
    sockets[1].open()
    await tick()
    sockets[1].message(['AUTH', 'c1'])
    const authB = authEvent(alice, { challenge: 'c1' })
    memberB.send(JSON.stringify(['AUTH', authB]))
    await tick()

    const memberC = pool.attach('wss://relay.example', {})
    await tick()
    assert.equal(sockets.length, 3)
    sockets[2].open()
    await tick()
    memberC.send(JSON.stringify(['REQ', 'c1', { kinds: [1] }]))
    memberC.send(JSON.stringify(['REQ', 'c2', { kinds: [1] }]))
    await tick()

    memberA.send(JSON.stringify(['CLOSE', 'a1']))
    await tick()
    assert.equal(pool.snapshot().consolidations, 0)
    assert.equal(sockets[1].sent.some(message => message[0] === 'REQ' && message[1].includes(':c1')), false)
    assert.equal(sockets[0].sent.some(message => message[0] === 'REQ' && (message[1].includes(':c1') || message[1].includes(':c2'))), false)

    sockets[1].message(['OK', authB.id, false, 'restricted'])
    memberA.send(JSON.stringify(['CLOSE', 'a2']))
    await tick()
    assert.equal(pool.snapshot().consolidations, 2)
  })

  it('falls back to a throttled partial move when an anonymous source cannot empty at once', async () => {
    const { pool, sockets } = createPool({ maxSubscriptionsPerBucket: 2 })
    const memberA = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    memberA.send(JSON.stringify(['REQ', 'a1', { kinds: [1] }]))
    memberA.send(JSON.stringify(['REQ', 'a2', { kinds: [1] }]))
    await tick()

    const memberB = pool.attach('wss://relay.example', {})
    await tick()
    sockets[1].open()
    await tick()
    memberB.send(JSON.stringify(['NEG-OPEN', 'negB', { kinds: [1] }, 'bb']))
    await tick()
    const nsNegB = sockets[1].sent.find(message => message[0] === 'NEG-OPEN')[1]
    sockets[1].message(['NEG-MSG', nsNegB, 'payload'])
    await tick()

    const memberD = pool.attach('wss://relay.example', {})
    await tick()
    memberD.send(JSON.stringify(['REQ', 'd1', { kinds: [1] }]))
    await tick()
    memberB.send(JSON.stringify(['REQ', 'b1', { kinds: [1] }]))
    await tick()

    memberA.send(JSON.stringify(['CLOSE', 'a1']))
    await tick()
    assert.equal(pool.snapshot().consolidations, 1)
    assert.equal(sockets[0].sent.some(message => message[0] === 'REQ' && message[1].includes('d1')), true)
    assert.equal(sockets[0].sent.some(message => message[0] === 'REQ' && message[1].includes('b1')), false)
  })

  it('closes a NEG session on relay NEG-ERR and consolidates the freed member', async () => {
    const { pool, sockets } = createPool()
    const alice = generateSecretKey()
    const received = []
    const { nsNegB } = await setupTwoAuthBucketsWithNeg({
      pool,
      sockets,
      alice,
      handlersB: { onMessage: raw => received.push(JSON.parse(raw)) }
    })
    sockets[1].message(['NEG-ERR', nsNegB, 'closed: too slow'])
    await tick()
    assert.equal(received.some(message => message[0] === 'NEG-ERR' && message[1] === 'negB'), true)
    assert.equal(pool.snapshot().consolidations, 1)
    assert.equal(sockets[0].sent.some(message => message[0] === 'REQ' && message[1].includes('b')), true)
  })

  it('replaces an open NEG session when the client reuses the raw id and unpins it', async () => {
    const { pool, sockets } = createPool()
    const alice = generateSecretKey()
    const { memberB, nsNegB } = await setupTwoAuthBucketsWithNeg({ pool, sockets, alice })
    memberB.send(JSON.stringify(['NEG-OPEN', 'negB', { kinds: [2] }, 'cc']))
    await tick()
    const opens = sockets[1].sent.filter(message => message[0] === 'NEG-OPEN')
    assert.equal(opens.length, 2)
    assert.equal(opens[0][1], nsNegB)
    assert.equal(opens[1][1], nsNegB)
    assert.equal(pool.snapshot().consolidations, 1)
    assert.equal(sockets[0].sent.some(message => message[0] === 'REQ' && message[1].includes('b')), true)
  })

  it('closes an idle NEG session with a synthetic NEG-ERR and keeps a tombstone', async () => {
    const { pool, sockets } = createPool({ negSessionIdleMs: 50, negTombstoneMs: 500 })
    const alice = generateSecretKey()
    const received = []
    const { memberB } = await setupTwoAuthBucketsWithNeg({
      pool,
      sockets,
      alice,
      handlersB: { onMessage: raw => received.push(JSON.parse(raw)) }
    })
    await new Promise(resolve => setTimeout(resolve, 70))
    assert.equal(received.some(message => message[0] === 'NEG-ERR' && message[1] === 'negB' && String(message[2]).startsWith('closed:')), true)
    assert.equal(pool.snapshot().consolidations, 1)
    received.length = 0
    memberB.send(JSON.stringify(['NEG-MSG', 'negB', 'late']))
    await tick()
    assert.equal(received.some(message => message[0] === 'NEG-ERR' && message[1] === 'negB'), true)
    memberB.send(JSON.stringify(['NEG-CLOSE', 'negB']))
    await tick()
  })

  it('times out a pending AUTH and keeps the bucket out of anonymous placement', async () => {
    const { pool, sockets } = createPool({ authPendingTimeoutMs: 20 })
    const alice = generateSecretKey()
    const received = []
    const memberA = pool.attach('wss://relay.example', { onMessage: raw => received.push(JSON.parse(raw)) })
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].message(['AUTH', 'c0'])
    const authA = authEvent(alice, { challenge: 'c0' })
    memberA.send(JSON.stringify(['AUTH', authA]))
    await tick()
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(received.some(message => message[0] === 'OK' && message[1] === authA.id && message[2] === false && message[3] === 'error: AUTH timeout'), true)
    pool.attach('wss://relay.example', {})
    await tick()
    assert.equal(sockets.length, 2)
  })

  it('spills a member into a new bucket when the current one is full', async () => {
    const { pool, sockets } = createPool({ maxSubscriptionsPerBucket: 1 })
    const member = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    member.send(JSON.stringify(['REQ', 'a', { kinds: [1] }]))
    await tick()
    member.send(JSON.stringify(['REQ', 'b', { kinds: [1] }]))
    await tick()
    assert.equal(sockets.length, 2)
    sockets[1].open()
    await tick()
    const replayed = sockets[1].sent.filter(message => message[0] === 'REQ')
    assert.equal(replayed.length, 2)
  })

  it('quarantines the relay and detaches members when the server breaks Nostr framing', async () => {
    const { pool, sockets } = createPool()
    const detaches = []
    pool.attach('wss://relay.example', { onDetach: reason => detaches.push(reason) })
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].message('not json')
    await tick()
    assert.equal(pool.isQuarantined('wss://relay.example'), true)
    assert.deepEqual(detaches, ['invalid-server-frame'])
  })

  it('closes only the offending member when its queue overflows', async () => {
    const { pool } = createPool({ maxQueuedFramesPerMember: 1 })
    const closed = []
    const member = pool.attach('wss://relay.example', { onClose: info => closed.push(info) })
    await tick()
    member.send(JSON.stringify(['REQ', 'a', { kinds: [1] }]))
    member.send(JSON.stringify(['REQ', 'b', { kinds: [1] }]))
    await tick()
    assert.deepEqual(closed.map(info => info.code), [1013])
    assert.equal(pool.snapshot().members, 0)
  })

  it('closes an empty bucket after the idle window', async () => {
    const { pool, sockets } = createPool({ bucketIdleMs: 10 })
    const member = pool.attach('wss://relay.example', {})
    await tick()
    sockets[0].open()
    await tick()
    member.close(1000, '')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(sockets[0].closed, { code: 1000, reason: 'idle' })
    assert.equal(pool.snapshot().buckets, 0)
  })
})
