import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

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
