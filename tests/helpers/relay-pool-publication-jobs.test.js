import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { finalizeEvent } from 'libp2r2p/event'
import { generateSecretKey } from 'libp2r2p/key'

import { RELAY_POOL_LIMITS } from '#services/relay-pool/constants.js'
import { UnifiedRelayPool } from '#services/relay-pool/pool.js'
import { RelayRegistry } from '#services/relay-pool/registry.js'

class FakeSocket {
  constructor (url) {
    this.url = url
    this.sent = []
    this.sentRaw = []
    this.readyState = 0
    this.extensions = ''
    this.closed = null
  }

  open () {
    this.readyState = 1
    this.onopen?.()
  }

  send (raw) {
    this.sentRaw.push(raw)
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

function createPool (overrides = {}) {
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
      ...overrides
    }
  })
  return { pool, sockets }
}

let eventSerial = 0

function event (secretKey = generateSecretKey(), overrides = {}) {
  return finalizeEvent({
    kind: 1,
    created_at: ++eventSerial,
    tags: [],
    content: `event-${eventSerial}`,
    ...overrides
  }, secretKey)
}

function authEvent (secretKey, challenge, relay = 'wss://relay.example') {
  return finalizeEvent({
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['relay', relay], ['challenge', challenge]],
    content: ''
  }, secretKey)
}

function received () {
  const frames = []
  return { frames, handlers: { onMessage: raw => frames.push(JSON.parse(raw)) } }
}

function eventFrames (socket, id = null) {
  return socket.sent.filter(frame => frame[0] === 'EVENT' && (!id || frame[1].id === id))
}

describe('relay pool publication jobs', () => {
  it('validates EVENT before queueing and returns a local OK false', async t => {
    const { pool, sockets } = createPool()
    t.after(() => pool.closeAll())
    const memberEvents = received()
    const member = pool.attach('wss://relay.example', memberEvents.handlers)
    await tick()
    sockets[0].open()
    await tick()

    const malformed = { id: 'bad' }
    const malformedEvent = event()
    const wrongId = { ...malformedEvent, id: '0'.repeat(64) }
    const badSignature = { ...event(), sig: '0'.repeat(128) }
    const missingId = { ...event(), id: 42 }
    for (const value of [malformed, wrongId, badSignature, missingId]) {
      member.send(JSON.stringify(['EVENT', value]))
    }
    await tick()

    assert.deepEqual(memberEvents.frames, [
      ['OK', 'bad', false, 'invalid: malformed event'],
      ['OK', wrongId.id, false, 'invalid: event id'],
      ['OK', badSignature.id, false, 'invalid: event signature'],
      ['OK', '', false, 'invalid: event id']
    ])
    assert.equal(sockets[0].sent.length, 0)
    assert.equal(pool.snapshot().framesOut, 0)
    assert.deepEqual(pool.snapshot().pendingPublicationsByRelay, {})
  })

  it('shares one physical EVENT between members of one bucket', async t => {
    const { pool, sockets } = createPool()
    t.after(() => pool.closeAll())
    const a = received()
    const b = received()
    const memberA = pool.attach('wss://relay.example', a.handlers)
    const memberB = pool.attach('wss://relay.example', b.handlers)
    await tick()
    sockets[0].open()
    await tick()
    const published = event()
    memberA.send(JSON.stringify(['EVENT', published]))
    memberB.send(JSON.stringify(['EVENT', published]))
    await tick()

    assert.equal(eventFrames(sockets[0], published.id).length, 1)
    assert.equal(pool.snapshot().framesOut, 1)
    assert.equal(pool.snapshot().pendingPublicationsByRelay['wss://relay.example'].awaitingOk, 2)
    sockets[0].message(['OK', published.id, true, 'saved'])
    await tick()
    assert.deepEqual(a.frames, [['OK', published.id, true, 'saved']])
    assert.deepEqual(b.frames, [['OK', published.id, true, 'saved']])
    assert.deepEqual(pool.snapshot().pendingPublicationsByRelay, {})
  })

  it('does not duplicate a pending EVENT from the same member', async t => {
    const { pool, sockets } = createPool()
    t.after(() => pool.closeAll())
    const a = received()
    const member = pool.attach('wss://relay.example', a.handlers)
    await tick()
    sockets[0].open()
    await tick()
    const published = event()
    member.send(JSON.stringify(['EVENT', published]))
    member.send(JSON.stringify(['EVENT', published]))
    await tick()

    assert.equal(eventFrames(sockets[0], published.id).length, 1)
    assert.equal(pool.snapshot().pendingPublicationsByRelay['wss://relay.example'].awaitingOk, 1)
    sockets[0].message(['OK', published.id, true, 'first'])
    await tick()
    member.send(JSON.stringify(['EVENT', published]))
    await tick()
    assert.equal(eventFrames(sockets[0], published.id).length, 2)
    sockets[0].message(['OK', published.id, true, 'second'])
    await tick()
    assert.deepEqual(a.frames, [
      ['OK', published.id, true, 'first'],
      ['OK', published.id, true, 'second']
    ])
  })

  it('accepts different valid signatures for the same event id as one job', async t => {
    const { pool, sockets } = createPool()
    t.after(() => pool.closeAll())
    const a = received()
    const b = received()
    const memberA = pool.attach('wss://relay.example', a.handlers)
    const memberB = pool.attach('wss://relay.example', b.handlers)
    await tick()
    sockets[0].open()
    await tick()

    const secretKey = generateSecretKey()
    const first = event(secretKey, { content: 'same event' })
    const second = event(secretKey, { content: 'same event', created_at: first.created_at })
    assert.equal(first.id, second.id)
    assert.notEqual(first.sig, second.sig)
    memberA.send(JSON.stringify(['EVENT', first]))
    memberB.send(JSON.stringify(['EVENT', second]))
    await tick()
    assert.equal(eventFrames(sockets[0], first.id).length, 1)
    assert.deepEqual(sockets[0].sent.find(frame => frame[0] === 'EVENT')[1], first)
    sockets[0].message(['OK', first.id, true, 'saved'])
    await tick()
    assert.deepEqual(a.frames, [['OK', first.id, true, 'saved']])
    assert.deepEqual(b.frames, [['OK', first.id, true, 'saved']])
  })

  it('keeps a shared job when only the overflowing follower is closed', async t => {
    const { pool, sockets } = createPool({ maxQueuedFramesPerMember: 1 })
    t.after(() => pool.closeAll())
    const memberA = pool.attach('wss://relay.example')
    let closedB
    const memberB = pool.attach('wss://relay.example', { onClose: info => { closedB = info } })
    await tick()
    const published = event()
    memberA.send(JSON.stringify(['EVENT', published]))
    memberB.send(JSON.stringify(['EVENT', published]))
    assert.ok(memberA.bufferedAmount > 0)
    assert.ok(memberB.bufferedAmount > 0)
    memberB.send(JSON.stringify(['REQ', 'overflow']))
    assert.deepEqual(closedB, { code: 1013, reason: 'relay pool queue overflow', wasClean: false })
    sockets[0].open()
    await tick()
    assert.equal(eventFrames(sockets[0], published.id).length, 1)
  })

  it('transfers a queued job from a removed leader without losing order', async t => {
    const { pool, sockets } = createPool()
    t.after(() => pool.closeAll())
    const b = received()
    const leader = pool.attach('wss://relay.example')
    const follower = pool.attach('wss://relay.example', b.handlers)
    await tick()
    const published = event()
    leader.send(JSON.stringify(['EVENT', published]))
    follower.send(JSON.stringify(['EVENT', published]))
    leader.close(1000, '')
    sockets[0].open()
    await tick()
    assert.equal(eventFrames(sockets[0], published.id).length, 1)
    sockets[0].message(['OK', published.id, true, 'saved'])
    await tick()
    assert.deepEqual(b.frames, [['OK', published.id, true, 'saved']])
  })

  it('moves a leader waiter by AUTH while the follower keeps the source job', async t => {
    const { pool, sockets } = createPool()
    t.after(() => pool.closeAll())
    const secretKey = generateSecretKey()
    const identity = pool.attach('wss://relay.example')
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].message(['AUTH', 'identity-challenge'])
    const identityAuth = authEvent(secretKey, 'identity-challenge')
    identity.send(JSON.stringify(['AUTH', identityAuth]))
    await tick()
    sockets[0].message(['OK', identityAuth.id, true, ''])
    await tick()

    const leaderEvents = received()
    const followerEvents = received()
    const leader = pool.attach('wss://relay.example', leaderEvents.handlers)
    const follower = pool.attach('wss://relay.example', followerEvents.handlers)
    await tick()
    assert.equal(sockets.length, 2)
    sockets[1].message(['AUTH', 'move-challenge'])
    const published = event()
    leader.send(JSON.stringify(['EVENT', published]))
    follower.send(JSON.stringify(['EVENT', published]))

    const movingAuth = authEvent(secretKey, 'move-challenge')
    leader.send(JSON.stringify(['AUTH', movingAuth]))
    await tick()
    assert.equal(eventFrames(sockets[0], published.id).length, 1)
    sockets[0].message(['OK', published.id, true, 'saved-after-move'])
    await tick()
    assert.deepEqual(leaderEvents.frames.filter(frame => frame[0] === 'OK'), [
      ['OK', movingAuth.id, true, 'relay pool: connection already authenticated'],
      ['OK', published.id, true, 'saved-after-move']
    ])
    assert.deepEqual(followerEvents.frames, [['OK', published.id, true, 'saved-after-move']])
    assert.equal(follower.bufferedAmount, 0)
  })

  it('charges queue limits per member while sending and consuming one token', async t => {
    const { pool, sockets } = createPool()
    t.after(() => pool.closeAll())
    const members = []
    for (let index = 0; index < 3; index++) {
      const member = pool.attach('wss://relay.example')
      members.push(member)
    }
    await tick()
    const published = event()
    for (const member of members) member.send(JSON.stringify(['EVENT', published]))
    for (const member of members) assert.ok(member.bufferedAmount > 0)
    sockets[0].open()
    await tick()
    assert.equal(eventFrames(sockets[0], published.id).length, 1)
    assert.equal(pool.snapshot().framesOut, 1)
    assert.equal(pool.snapshot().pendingPublicationsByRelay['wss://relay.example'].awaitingOk, 3)
    for (const member of members) assert.equal(member.bufferedAmount, 0)
  })

  it('propagates success to a queued publication in another bucket of the same relay', async t => {
    const { pool, sockets } = createPool({ maxSubscriptionsPerBucket: 1 })
    t.after(() => pool.closeAll())
    const a = received()
    const b = received()
    const memberA = pool.attach('wss://relay.example', a.handlers)
    await tick()
    sockets[0].open()
    await tick()
    memberA.send(JSON.stringify(['REQ', 'fill', {}]))
    await tick()
    const memberB = pool.attach('wss://relay.example', b.handlers)
    await tick()
    assert.equal(sockets.length, 2)

    const published = event()
    memberA.send(JSON.stringify(['EVENT', published]))
    await tick()
    memberB.send(JSON.stringify(['EVENT', published]))
    assert.ok(memberB.bufferedAmount > 0)
    sockets[0].message(['OK', published.id, true, 'saved'])
    await tick()
    assert.deepEqual(a.frames.filter(frame => frame[0] === 'OK'), [['OK', published.id, true, 'saved']])
    assert.deepEqual(b.frames, [['OK', published.id, true, 'saved']])
    assert.equal(memberB.bufferedAmount, 0)
    sockets[1].open()
    await tick()
    assert.equal(eventFrames(sockets[1], published.id).length, 0)
  })

  it('settles already sent copies in other buckets and ignores their late rejection', async t => {
    const { pool, sockets } = createPool({ maxSubscriptionsPerBucket: 1 })
    t.after(() => pool.closeAll())
    const a = received()
    const b = received()
    const memberA = pool.attach('wss://relay.example', a.handlers)
    await tick()
    sockets[0].open()
    await tick()
    memberA.send(JSON.stringify(['REQ', 'fill', {}]))
    await tick()
    const memberB = pool.attach('wss://relay.example', b.handlers)
    await tick()
    sockets[1].open()
    await tick()

    const published = event()
    memberA.send(JSON.stringify(['EVENT', published]))
    memberB.send(JSON.stringify(['EVENT', published]))
    await tick()
    assert.equal(eventFrames(sockets[0], published.id).length, 1)
    assert.equal(eventFrames(sockets[1], published.id).length, 1)
    sockets[0].message(['OK', published.id, true, 'saved'])
    await tick()
    assert.deepEqual(a.frames, [['OK', published.id, true, 'saved']])
    assert.deepEqual(b.frames, [['OK', published.id, true, 'saved']])
    sockets[1].message(['OK', published.id, false, 'invalid: late'])
    await tick()
    assert.equal(b.frames.length, 1)
  })

  it('keeps rejection scoped to the bucket that received it', async t => {
    const { pool, sockets } = createPool({ maxSubscriptionsPerBucket: 1 })
    t.after(() => pool.closeAll())
    const a = received()
    const b = received()
    const memberA = pool.attach('wss://relay.example', a.handlers)
    await tick()
    sockets[0].open()
    await tick()
    memberA.send(JSON.stringify(['REQ', 'fill', {}]))
    await tick()
    const memberB = pool.attach('wss://relay.example', b.handlers)
    await tick()
    sockets[1].open()
    await tick()
    const published = event()
    memberA.send(JSON.stringify(['EVENT', published]))
    memberB.send(JSON.stringify(['EVENT', published]))
    await tick()
    sockets[0].message(['OK', published.id, false, 'blocked: refused'])
    await tick()
    assert.deepEqual(a.frames, [['OK', published.id, false, 'blocked: refused']])
    assert.deepEqual(b.frames, [])
    sockets[1].message(['OK', published.id, true, 'saved-b'])
    await tick()
    assert.deepEqual(b.frames, [['OK', published.id, true, 'saved-b']])
  })

  it('does not propagate success across relay URLs', async t => {
    const { pool, sockets } = createPool()
    t.after(() => pool.closeAll())
    const a = received()
    const b = received()
    const memberA = pool.attach('wss://a.example', a.handlers)
    const memberB = pool.attach('wss://b.example', b.handlers)
    await tick()
    sockets[0].open()
    sockets[1].open()
    await tick()
    const published = event()
    memberA.send(JSON.stringify(['EVENT', published]))
    memberB.send(JSON.stringify(['EVENT', published]))
    await tick()
    sockets[0].message(['OK', published.id, true, 'saved-a'])
    await tick()
    assert.deepEqual(a.frames, [['OK', published.id, true, 'saved-a']])
    assert.deepEqual(b.frames, [])
    sockets[1].message(['OK', published.id, true, 'saved-b'])
    await tick()
    assert.deepEqual(b.frames, [['OK', published.id, true, 'saved-b']])
  })

  it('does not propagate success across paths of the same host', async t => {
    const { pool, sockets } = createPool()
    t.after(() => pool.closeAll())
    const a = received()
    const b = received()
    const memberA = pool.attach('wss://relay.example/one', a.handlers)
    const memberB = pool.attach('wss://relay.example/two', b.handlers)
    await tick()
    sockets[0].open()
    sockets[1].open()
    await tick()
    const published = event()
    memberA.send(JSON.stringify(['EVENT', published]))
    memberB.send(JSON.stringify(['EVENT', published]))
    await tick()
    sockets[0].message(['OK', published.id, true, 'saved-one'])
    await tick()
    assert.deepEqual(a.frames, [['OK', published.id, true, 'saved-one']])
    assert.deepEqual(b.frames, [])
  })

  it('delivers one rate-limit rejection and advice to every shared waiter', async t => {
    const { pool, sockets } = createPool()
    t.after(() => pool.closeAll())
    const a = received()
    const b = received()
    const memberA = pool.attach('wss://relay.example', a.handlers)
    const memberB = pool.attach('wss://relay.example', b.handlers)
    await tick()
    sockets[0].open()
    await tick()
    const published = event()
    memberA.send(JSON.stringify(['EVENT', published]))
    memberB.send(JSON.stringify(['EVENT', published]))
    await tick()
    sockets[0].message(['OK', published.id, false, 'rate-limited: busy', '2500'])
    await tick()
    for (const frames of [a.frames, b.frames]) {
      assert.deepEqual(frames[0].slice(0, 4), ['OK', published.id, false, 'rate-limited: busy'])
      assert.ok(Number(frames[0][4]) > 0 && Number(frames[0][4]) <= 2500)
    }
    assert.deepEqual(pool.snapshot().pendingPublicationsByRelay, {})
  })

  it('cross-bucket success cancels automatic AUTH in another bucket', async t => {
    const { pool, sockets } = createPool({ maxSubscriptionsPerBucket: 1 })
    t.after(() => pool.closeAll())
    const secretKey = generateSecretKey()
    let resolveCanAuthenticate
    let signCalls = 0
    const provider = {
      canAuthenticate: () => new Promise(resolve => { resolveCanAuthenticate = resolve }),
      signAuth: async () => {
        signCalls++
        return authEvent(secretKey, 'challenge')
      }
    }
    const a = received()
    const b = received()
    const memberA = pool.attach('wss://relay.example', a.handlers, { auth: provider })
    await tick()
    sockets[0].open()
    await tick()
    memberA.send(JSON.stringify(['REQ', 'fill', {}]))
    await tick()
    const memberB = pool.attach('wss://relay.example', b.handlers)
    await tick()
    sockets[1].open()
    await tick()

    const published = event(secretKey, { kind: 3560 })
    memberA.send(JSON.stringify(['EVENT', published]))
    await tick()
    sockets[0].message(['OK', published.id, false, 'auth-required: authenticate'])
    await tick()
    assert.equal(typeof resolveCanAuthenticate, 'function')

    memberB.send(JSON.stringify(['EVENT', published]))
    await tick()
    sockets[1].message(['OK', published.id, true, 'saved-elsewhere'])
    await tick()
    assert.equal(signCalls, 0)
    assert.deepEqual(a.frames, [['OK', published.id, true, 'saved-elsewhere']])
    assert.deepEqual(b.frames, [['OK', published.id, true, 'saved-elsewhere']])
    resolveCanAuthenticate(false)
  })

  it('keeps automatic AUTH decisions independent for shared EVENT waiters', async t => {
    const { pool, sockets } = createPool()
    t.after(() => pool.closeAll())
    const secretA = generateSecretKey()
    const secretB = generateSecretKey()
    let signCallsA = 0
    let signCallsB = 0
    const providerA = {
      canAuthenticate: async () => true,
      signAuth: async request => {
        signCallsA++
        return authEvent(secretA, request.challenge, request.relay)
      }
    }
    const providerB = {
      canAuthenticate: async () => false,
      signAuth: async request => {
        signCallsB++
        return authEvent(secretB, request.challenge, request.relay)
      }
    }
    const a = received()
    const b = received()
    const memberA = pool.attach('wss://relay.example', a.handlers, { auth: providerA })
    const memberB = pool.attach('wss://relay.example', b.handlers, { auth: providerB })
    await tick()
    sockets[0].open()
    await tick()
    sockets[0].message(['AUTH', 'source-challenge'])
    const published = event(secretA, { kind: 3560 })
    memberA.send(JSON.stringify(['EVENT', published]))
    memberB.send(JSON.stringify(['EVENT', published]))
    await tick()
    assert.equal(eventFrames(sockets[0], published.id).length, 1)
    sockets[0].message(['OK', published.id, false, 'auth-required: original'])
    await tick()
    await tick()

    assert.deepEqual(b.frames.filter(frame => frame[0] === 'OK'), [
      ['OK', published.id, false, 'auth-required: original']
    ])
    assert.equal(signCallsB, 0)
    const isolated = sockets[1]
    assert.ok(isolated)
    isolated.open()
    isolated.message(['AUTH', 'isolated-challenge'])
    await tick()
    assert.equal(signCallsA, 1)
    assert.equal(isolated.sent.filter(frame => frame[0] === 'AUTH').length, 1)
  })
})
