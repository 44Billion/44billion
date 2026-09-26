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
      bucketIdleMs: 20,
      ...overrides
    },
    log: () => {}
  })
  return { pool, sockets }
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

  it('forces a reconnect when a confirmed bucket exists but cannot receive the socket', async () => {
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
    assert.equal(closed.at(-1).code, 1006)
    assert.equal(sockets[1].sent.some(message => message[0] === 'AUTH'), false)
    assert.equal(pool.snapshot().authReconnects, 1)
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
