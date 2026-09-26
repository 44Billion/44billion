import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createBridgeTransport } from '#services/relay-pool/app-shim.js'
import { createRelayBridgeEndpoint } from '#services/relay-pool/bridge-endpoint.js'
import { RELAY_POOL_LIMITS } from '#services/relay-pool/constants.js'
import { RelayRegistry } from '#services/relay-pool/registry.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

async function waitFor (predicate, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return
    await tick()
  }
  throw new Error('condition not met')
}

class FakeVirtualSocket {
  static instances = []

  constructor (url) {
    this.url = url
    this.extensions = ''
    this.sent = []
    this.readyState = 0
    FakeVirtualSocket.instances.push(this)
  }

  open () { this.readyState = 1; this.onopen?.() }
  send (data) { this.sent.push(data) }
  message (data) { this.onmessage?.({ data }) }
  close (code = 1000, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason, wasClean: true })
  }
}

function createFakePool () {
  const attached = []
  return {
    registry: new RelayRegistry(),
    quarantined: new Set(),
    isQuarantined (url) {
      return this.quarantined.has(url)
    },
    failures: [],
    recordFailure (url, info) {
      this.failures.push({ url, ...info })
    },
    attach (url, handlers, options = {}) {
      const member = {
        url,
        handlers,
        owner: options.owner,
        sent: [],
        send (data) {
          member.sent.push(data)
        },
        close () {
          handlers.onClose?.({ code: 1000, reason: '', wasClean: true })
        }
      }
      attached.push(member)
      return member
    },
    attached
  }
}

function createBridge (pool, url = 'wss://relay.example', { limits = RELAY_POOL_LIMITS, ...endpointOptions } = {}) {
  const { port1: appPort, port2: launcherPort } = new MessageChannel()
  const endpoint = createRelayBridgeEndpoint({ port: launcherPort, pool, limits, ...endpointOptions })
  const events = []
  const transport = createBridgeTransport({
    url,
    callbacks: {
      onOpen: info => events.push(['open', info]),
      onMessage: data => events.push(['message', data]),
      onClose: info => events.push(['close', info]),
      onDetach: reason => events.push(['detach', reason])
    },
    getPort: async () => appPort,
    limits,
    log: () => {}
  })
  return {
    endpoint,
    transport,
    events,
    pool,
    appPort,
    cleanup () {
      transport.close(1000, '')
      endpoint.dispose()
      appPort.close()
      launcherPort.close()
    }
  }
}

describe('relay pool bridge', () => {
  it('attaches a virtual socket, forwards frames and closes it', async t => {
    const pool = createFakePool()
    const { events, transport, cleanup } = createBridge(pool)
    t.after(cleanup)
    await tick()
    assert.equal(pool.attached.length, 1)
    pool.attached[0].handlers.onOpen({ extensions: '' })
    await tick()
    assert.deepEqual(events, [['open', { extensions: '' }]])

    transport.send('["REQ","sub1",{}]')
    await tick()
    assert.deepEqual(pool.attached[0].sent, ['["REQ","sub1",{}]'])

    pool.attached[0].handlers.onMessage('["EOSE","sub1"]')
    await tick()
    assert.deepEqual(events.at(-1), ['message', '["EOSE","sub1"]'])

    transport.close(1000, '')
    await tick()
    assert.deepEqual(events.at(-1), ['close', { code: 1000, reason: '', wasClean: true }])
  })

  it('detaches instead of attaching when the relay is quarantined', async t => {
    const pool = createFakePool()
    pool.quarantined.add('wss://relay.example')
    const { events, transport, cleanup } = createBridge(pool)
    t.after(cleanup)
    await tick()
    await tick()
    assert.deepEqual(events, [['detach', 'quarantined']])
    assert.equal(pool.attached.length, 0)
    transport.close(1000, '')
  })

  it('delegates the virtual socket to the launcher in vault mode', async t => {
    FakeVirtualSocket.instances = []
    const pool = createFakePool()
    const { events, transport, cleanup } = createBridge(pool, 'wss://relay.example', {
      delegate: true,
      owner: 'vault',
      createVirtualSocket: url => new FakeVirtualSocket(url)
    })
    t.after(cleanup)
    await tick()
    assert.equal(pool.attached.length, 0)
    assert.equal(FakeVirtualSocket.instances.length, 1)
    const socket = FakeVirtualSocket.instances[0]
    socket.open()
    await tick()
    assert.deepEqual(events, [['open', { extensions: '' }]])

    transport.send('["REQ","sub1",{}]')
    await tick()
    assert.deepEqual(socket.sent, ['["REQ","sub1",{}]'])

    socket.message('["EOSE","sub1"]')
    await tick()
    assert.deepEqual(events.at(-1), ['message', '["EOSE","sub1"]'])

    transport.close(1000, '')
    await tick()
    assert.deepEqual(events.at(-1), ['close', { code: 1000, reason: '', wasClean: true }])
  })

  it('records relay failures reported by the app side', async t => {
    const pool = createFakePool()
    const { appPort, cleanup } = createBridge(pool)
    t.after(cleanup)
    appPort.postMessage({
      code: 'RELAY_FAILURE',
      payload: {
        url: 'wss://relay.example',
        code: 1006,
        reason: 'boom',
        phase: 'speculative',
        wasClean: false,
        openedAt: 123,
        lifetimeMs: 45
      }
    })
    await tick()
    assert.deepEqual(pool.failures, [{
      url: 'wss://relay.example',
      code: 1006,
      reason: 'boom',
      phase: 'speculative',
      wasClean: false,
      openedAt: 123,
      lifetimeMs: 45
    }])
  })

  it('records an attach timeout as a relay failure', async t => {
    const pool = createFakePool()
    const { cleanup } = createBridge(pool, 'wss://relay.example', {
      limits: { ...RELAY_POOL_LIMITS, speculativeDecisionTimeoutMs: 10 }
    })
    t.after(cleanup)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(pool.failures[0]?.code, 1006)
    assert.equal(pool.failures[0]?.phase, 'attach')
    assert.equal(pool.failures[0]?.lifetimeMs, null)
  })

  it('detaches the vault socket when the launcher pool is unavailable', async t => {
    const pool = createFakePool()
    const { events, cleanup } = createBridge(pool, 'wss://relay.example', {
      delegate: true,
      owner: 'vault',
      createVirtualSocket: () => null
    })
    t.after(cleanup)
    await tick()
    await tick()
    assert.deepEqual(events, [['detach', 'relay-pool-unavailable']])
  })

  it('replenishes app-to-launcher credit so long send bursts keep flowing', async t => {
    const pool = createFakePool()
    const limits = { ...RELAY_POOL_LIMITS, bridgeCreditFrames: 2, bridgeCreditBytes: 1024 }
    const { transport, cleanup } = createBridge(pool, 'wss://relay.example', { limits })
    t.after(cleanup)
    await tick()
    pool.attached[0].handlers.onOpen({ extensions: '' })
    await tick()
    for (let i = 0; i < 6; i++) transport.send(JSON.stringify(['REQ', `sub${i}`, { kinds: [1] }]))
    await waitFor(() => pool.attached[0].sent.length === 6)
  })

  it('marks app attachments with the endpoint owner', async t => {
    const pool = createFakePool()
    const { cleanup } = createBridge(pool, 'wss://relay.example', { owner: 'vault' })
    t.after(cleanup)
    await tick()
    assert.equal(pool.attached[0].owner, 'vault')
  })

  it('adds a relay to the shared registry on attach', async t => {
    const pool = createFakePool()
    const { cleanup } = createBridge(pool)
    t.after(cleanup)
    await tick()
    assert.equal(pool.registry.hasRelay('wss://relay.example'), true)
  })
})
