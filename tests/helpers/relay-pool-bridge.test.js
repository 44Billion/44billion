import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createBridgeTransport } from '#services/relay-pool/app-shim.js'
import { createRelayBridgeEndpoint } from '#services/relay-pool/bridge-endpoint.js'
import { RELAY_POOL_LIMITS } from '#services/relay-pool/constants.js'
import { RelayRegistry } from '#services/relay-pool/registry.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

function createFakePool () {
  const attached = []
  return {
    registry: new RelayRegistry(),
    quarantined: new Set(),
    isQuarantined (url) {
      return this.quarantined.has(url)
    },
    attach (url, handlers) {
      const member = {
        url,
        handlers,
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

function createBridge (pool, url = 'wss://relay.example') {
  const { port1: appPort, port2: launcherPort } = new MessageChannel()
  const endpoint = createRelayBridgeEndpoint({ port: launcherPort, pool, limits: RELAY_POOL_LIMITS })
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
    limits: RELAY_POOL_LIMITS,
    log: () => {}
  })
  return {
    endpoint,
    transport,
    events,
    pool,
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

  it('adds a relay to the shared registry on attach', async t => {
    const pool = createFakePool()
    const { cleanup } = createBridge(pool)
    t.after(cleanup)
    await tick()
    assert.equal(pool.registry.hasRelay('wss://relay.example'), true)
  })
})
