import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RelayPool } from 'libp2r2p/relay'
import { finalizeEvent } from 'libp2r2p/event'
import { generateSecretKey } from 'libp2r2p/key'

import { createBridgeTransport } from '#services/relay-pool/app-shim.js'
import { createRelayBridgeEndpoint } from '#services/relay-pool/bridge-endpoint.js'
import { RELAY_POOL_LIMITS } from '#services/relay-pool/constants.js'
import { UnifiedRelayPool } from '#services/relay-pool/pool.js'
import { RelayRegistry } from '#services/relay-pool/registry.js'
import { createRelayPoolWebSocketClass } from '#services/relay-pool/virtual-socket.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

async function waitFor (predicate, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return
    await tick()
  }
  throw new Error('condition not met')
}

class PhysicalSocket {
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
    this.onmessage?.({ data: JSON.stringify(value) })
  }
}

class AppRealmWebSocket extends EventTarget {
  constructor (url) {
    super()
    this.url = url
    this.readyState = 0
  }

  send () {}
  close () {}
}

describe('relay pool end to end', () => {
  it('shares one physical connection between two app virtual sockets', async t => {
    const physical = []
    const limits = { ...RELAY_POOL_LIMITS, maxNewConnectionsPerSecond: 100, maxNewConnectionsPerWindow: 100, bucketIdleMs: 20 }
    const registry = new RelayRegistry(['wss://relay.example'])
    const pool = new UnifiedRelayPool({
      createSocket: url => {
        const socket = new PhysicalSocket(url)
        physical.push(socket)
        return socket
      },
      registry,
      limits,
      log: () => {}
    })
    const { port1: appPort, port2: launcherPort } = new MessageChannel()
    const endpoint = createRelayBridgeEndpoint({ port: launcherPort, pool, limits })
    t.after(() => {
      pool.closeAll()
      endpoint.dispose()
      appPort.close()
      launcherPort.close()
    })

    const AppWebSocket = createRelayPoolWebSocketClass({
      OriginalWebSocket: AppRealmWebSocket,
      registry,
      baseUrl: 'https://app.example/',
      limits,
      log: () => {},
      createPoolTransport: ({ url, callbacks }) => createBridgeTransport({
        url,
        callbacks,
        getPort: async () => appPort,
        limits,
        log: () => {}
      })
    })
    const a = new AppWebSocket('wss://relay.example')
    const b = new AppWebSocket('wss://relay.example')
    await waitFor(() => physical.length === 1)
    physical[0].open()
    await waitFor(() => a.readyState === 1 && b.readyState === 1)
    assert.equal(pool.snapshot().members, 2)
    assert.equal(pool.snapshot().buckets, 1)

    const receivedA = []
    const receivedB = []
    a.onmessage = event => receivedA.push(JSON.parse(event.data))
    b.onmessage = event => receivedB.push(JSON.parse(event.data))
    a.send(JSON.stringify(['REQ', 'sub1', { kinds: [1] }]))
    b.send(JSON.stringify(['REQ', 'sub1', { kinds: [1] }]))
    await waitFor(() => physical[0].sent.filter(message => message[0] === 'REQ').length === 2)
    const requests = physical[0].sent.filter(message => message[0] === 'REQ')
    assert.notEqual(requests[0][1], requests[1][1])

    const event = { id: 'e'.repeat(64), pubkey: 'p'.repeat(64), sig: 's'.repeat(128), kind: 1, created_at: 1, tags: [], content: '' }
    physical[0].message(['EVENT', requests[0][1], event])
    await waitFor(() => receivedA.length === 1)
    assert.equal(receivedA[0][0], 'EVENT')
    assert.equal(receivedA[0][1], 'sub1')
    assert.deepEqual(receivedB, [])
  })
})

// Exercises the installed library and real MessagePorts. Only upstream socket
// I/O is controlled; publication validation, timeout reports and routing are real.
function publicationFixture (t, onEvent, onRequest = () => {}) {
  const urls = ['wss://one.example', 'wss://two.example']
  const logs = []
  const registry = new RelayRegistry(urls)
  const limits = { ...RELAY_POOL_LIMITS, slowPublicationMs: 0, bucketIdleMs: 20 }
  const pool = new UnifiedRelayPool({
    registry, limits, log: (...args) => logs.push(args),
    createSocket: url => {
      const socket = new PhysicalSocket(url)
      socket.send = raw => {
        const frame = JSON.parse(raw)
        socket.sent.push(frame)
        if (frame[0] === 'EVENT') onEvent(socket, frame[1])
        if (frame[0] === 'REQ') onRequest(socket, frame[1])
      }
      queueMicrotask(() => socket.open())
      return socket
    }
  })
  const { port1, port2 } = new MessageChannel()
  const endpoint = createRelayBridgeEndpoint({ port: port2, pool, limits })
  const WebSocket = createRelayPoolWebSocketClass({
    OriginalWebSocket: AppRealmWebSocket, registry, limits,
    baseUrl: 'https://app.example/',
    createPoolTransport: ({ url, callbacks }) => createBridgeTransport({ url, callbacks, getPort: async () => port1, limits })
  })
  const publisher = new RelayPool({ WebSocket })
  t.after(async () => {
    await publisher.disconnectAll()
    endpoint.dispose()
    pool.closeAll()
    port1.close()
    port2.close()
  })
  const event = finalizeEvent({ kind: 3560, created_at: 1, tags: [], content: 'test ciphertext' }, generateSecretKey())
  return { publisher, urls, logs, event }
}

it('the installed publisher receives both relay acknowledgements on repeated publication through the app bridge', async t => {
  const fixture = publicationFixture(t, (socket, event) => socket.message(['OK', event.id, true, 'saved']))
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await fixture.publisher.sendEvent(fixture.event, fixture.urls, { timeoutUntilFirstFulfillment: 1000, timeout: 2000 })
    const report = await result.promise
    assert.equal(result.success, true, 'a repeated publication must not time out on two accepting relays')
    assert.equal(report.fulfilled, 2)
    assert.deepEqual(report.errors, [])
  }
})

it('delivery before a late OK can coexist with a final timeout report', async t => {
  const delivered = []
  const acknowledgements = []
  const fixture = publicationFixture(t, (socket, event) => {
    delivered.push(event.id)
    acknowledgements.push(() => socket.message(['OK', event.id, true, 'saved']))
  })
  const result = await fixture.publisher.sendEvent(fixture.event, fixture.urls, { timeoutUntilFirstFulfillment: 200, timeout: 2000 })
  const report = await result.promise
  assert.deepEqual(delivered, [fixture.event.id, fixture.event.id], 'both relays received the event before the deadline')
  assert.equal(result.success, false)
  assert.ok(report.errors.every(({ reason }) => reason.message === 'PUBLISH_TIMEOUT'))
  for (const acknowledge of acknowledgements) acknowledge()
  await waitFor(() => fixture.logs.filter(([label]) => label === 'slow publication response').length === 2)
  assert.ok(fixture.logs.filter(([label]) => label === 'slow publication response').every(([, response]) => response.accepted))
  assert.equal((await result.promise).success, false, 'a late OK does not revise the already finalized library report')
})

it('the installed reader receives all queued history before EOSE completes the query', async t => {
  const secret = generateSecretKey()
  const events = Array.from({ length: 5 }, (_, index) => finalizeEvent({
    kind: 3560, created_at: index + 1, tags: [], content: 'x'.repeat(60 * 1024)
  }, secret))
  const fixture = publicationFixture(t, () => {}, (socket, subscription) => {
    for (const event of events) socket.message(['EVENT', subscription, event])
    socket.message(['EOSE', subscription])
  })
  const report = await fixture.publisher.getEvents({ kinds: [3560] }, fixture.urls.slice(0, 1), { timeout: 2000 })
  assert.deepEqual(report.result.map(({ event }) => event.id), events.map(event => event.id))
  assert.deepEqual(report.errors, [])
  assert.equal(report.relays[0].status, 'eose')
})
