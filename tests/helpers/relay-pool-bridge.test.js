import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createBridgeTransport } from '#services/relay-pool/app-shim.js'
import { createRelayBridgeEndpoint, relayBridgeSnapshot } from '#services/relay-pool/bridge-endpoint.js'
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

function createBridge (pool, url = 'wss://relay.example', { limits = RELAY_POOL_LIMITS, transportLimits = limits, ...endpointOptions } = {}) {
  const { port1: appPort, port2: launcherPort } = new MessageChannel()
  const endpoint = createRelayBridgeEndpoint({ port: launcherPort, pool, limits, log: () => {}, ...endpointOptions })
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
    limits: transportLimits,
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
      // Exercise the endpoint deadline independently of the app deadline.
      transportLimits: RELAY_POOL_LIMITS,
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

for (const owner of ['app', 'vault']) {
  it(`keeps EOSE behind queued large events for ${owner}`, async t => {
    const pool = createFakePool()
    let socket
    let clock = 100
    const bridge = createBridge(pool, 'wss://relay.example', {
      owner,
      now: () => clock,
      delegate: owner === 'vault',
      createVirtualSocket: url => (socket = new FakeVirtualSocket(url))
    })
    t.after(bridge.cleanup)
    await tick()
    const source = socket ?? {
      open: () => pool.attached[0].handlers.onOpen({}),
      message: data => pool.attached[0].handlers.onMessage(data)
    }
    source.open()
    await tick()
    const frames = Array.from({ length: 5 }, (_, index) => JSON.stringify(['EVENT', 'history', { content: `${index}${'x'.repeat(60 * 1024)}` }]))
    for (const frame of frames) source.message(frame)
    clock += 25
    frames.push('["EOSE","history"]')
    source.message(frames.at(-1))
    const pending = bridge.endpoint.snapshot().queues[0]
    assert.equal(pending.owner, owner)
    assert.equal(pending.queuedFrames, 2)
    assert.equal(pending.oldestQueuedMs, 25)
    assert.equal(pending.headFrameBytes, frames[4].length)
    assert.equal(pending.queuedBytes, frames[4].length + frames[5].length)
    await waitFor(() => bridge.events.filter(([type]) => type === 'message').length === 6)
    assert.deepEqual(bridge.events.filter(([type]) => type === 'message').map(([, data]) => data), frames)
    assert.deepEqual(bridge.endpoint.snapshot().queues, [])
  })
}

it('returns trailing receive credit so a large next frame cannot stall', async t => {
  const pool = createFakePool()
  const bridge = createBridge(pool)
  t.after(bridge.cleanup)
  await tick()
  pool.attached[0].handlers.onOpen({})
  await tick()
  const frames = ['a'.repeat(32 * 1024), 'b'.repeat(250 * 1024)]
  frames.forEach(frame => pool.attached[0].handlers.onMessage(frame))
  await waitFor(() => bridge.events.filter(([type]) => type === 'message').length === 2)
  assert.deepEqual(bridge.events.filter(([type]) => type === 'message').map(([, data]) => data), frames)
})

it('keeps outgoing small frames behind previously queued large frames', async t => {
  const pool = createFakePool()
  const bridge = createBridge(pool)
  t.after(bridge.cleanup)
  await tick()
  pool.attached[0].handlers.onOpen({})
  await tick()
  const frames = ['a'.repeat(200 * 1024), 'b'.repeat(100 * 1024), '["CLOSE","history"]']
  frames.forEach(frame => bridge.transport.send(frame))
  await waitFor(() => pool.attached[0].sent.length === 3)
  assert.deepEqual(pool.attached[0].sent, frames)
  assert.equal(bridge.transport.bufferedAmount, 0)
})

it('releases the launcher attachment on outgoing overflow', async t => {
  const pool = createFakePool()
  const bridge = createBridge(pool, 'wss://relay.example', {
    limits: { ...RELAY_POOL_LIMITS, bridgeCreditFrames: 1, maxQueuedFramesPerMember: 2 }
  })
  t.after(bridge.cleanup)
  await tick()
  pool.attached[0].handlers.onOpen({})
  await tick()
  for (let i = 0; i < 4; i++) bridge.transport.send(`frame-${i}`)
  assert.equal(bridge.transport.bufferedAmount, 0)
  assert.deepEqual(bridge.events.at(-1), ['close', { code: 1013, reason: 'relay bridge queue overflow', wasClean: false }])
  await waitFor(() => bridge.endpoint.snapshot().attachments === 0)
  assert.deepEqual(pool.attached[0].sent, ['frame-0'])
  pool.attached[0].handlers.onMessage('late frame')
  await tick()
  assert.equal(bridge.events.filter(([type]) => type === 'message').length, 0)
})

for (const exceeded of ['frames', 'bytes']) {
  it(`retains bounded overflow diagnostics for the ${exceeded} limit without retaining frames`, async t => {
    const pool = createFakePool()
    let clock = 0
    const logs = []
    const baseline = relayBridgeSnapshot().queueOverflows
    const bridge = createBridge(pool, 'wss://relay.example', {
      owner: 'vault', now: () => clock, log: (...args) => logs.push(args),
      limits: { ...RELAY_POOL_LIMITS, bridgeCreditFrames: 1, bridgeCreditBytes: 16, maxQueuedFramesPerMember: exceeded === 'frames' ? 2 : 10, maxQueuedBytesPerMember: exceeded === 'bytes' ? 20 : 1024 }
    })
    t.after(bridge.cleanup)
    await tick()
    pool.attached[0].handlers.onOpen({})
    await tick()
    const data = 'private-content'
    const frames = exceeded === 'frames' ? 3 : 2
    pool.attached[0].handlers.onMessage(data)
    pool.attached[0].handlers.onMessage(data)
    clock = 40
    for (let i = 1; i < frames; i++) pool.attached[0].handlers.onMessage(data)
    const snapshot = relayBridgeSnapshot()
    assert.equal(snapshot.queueOverflows, baseline + 1)
    assert.equal(snapshot.queuedFrames, 0)
    assert.equal(bridge.endpoint.snapshot().attachments, 0)
    const overflow = snapshot.recentOverflows.at(-1)
    assert.equal(overflow.owner, 'vault')
    assert.equal(overflow.relay, 'wss://relay.example')
    assert.equal(overflow.queuedFrames, frames)
    assert.equal(overflow.queuedBytes, frames * data.length)
    assert.equal(overflow.oldestQueuedMs, 40)
    assert.equal(overflow.credit.frames, 0)
    assert.deepEqual(overflow.exceeded, [exceeded])
    assert.equal(JSON.stringify(snapshot).includes(data), false)
    assert.deepEqual(logs, [['relay endpoint queue overflow', overflow]])
    overflow.credit.frames = 999
    overflow.limits.frames = 999
    overflow.exceeded.push('mutated')
    assert.notDeepEqual(relayBridgeSnapshot().recentOverflows.at(-1), overflow)
    await waitFor(() => bridge.events.some(([type]) => type === 'close'))
    assert.equal(bridge.events.at(-1)[1].code, 1013)
    bridge.endpoint.dispose()
    assert.equal(relayBridgeSnapshot().recentOverflows.at(-1).queuedFrames, frames)
  })
}

it('bounds overflow history across retired endpoints', async () => {
  const baseline = relayBridgeSnapshot().queueOverflows
  for (let index = 0; index < 20; index++) {
    const pool = createFakePool()
    const bridge = createBridge(pool, 'wss://relay.example', {
      limits: { ...RELAY_POOL_LIMITS, bridgeCreditFrames: 1, maxQueuedFramesPerMember: 1 }
    })
    try {
      await tick()
      for (let count = 0; count < 3; count++) pool.attached[0].handlers.onMessage('frame')
    } finally { bridge.cleanup() }
  }
  const snapshot = relayBridgeSnapshot()
  assert.equal(snapshot.queueOverflows, baseline + 20)
  assert.equal(snapshot.recentOverflows.length, 16)
  assert.equal(snapshot.attachments, 0)
  assert.equal(snapshot.endpoints, 0)
})
