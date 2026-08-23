import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  findReadyBridgeClient,
  pruneReadyClients
} from '../../src/helpers/service-worker-bridge-router.js'

describe('service worker bridge router', () => {
  it('prefers the most recently ready trusted client without an app query marker', () => {
    const clients = [
      { id: 'app-1', url: 'https://42.example.com/app' },
      { id: 'trusted-1', url: 'https://42.example.com/~~napp?bridgeId=7' },
      { id: 'trusted-2', url: 'https://42.example.com/~~napp?bridgeId=8' }
    ]
    const readyClients = new Map([
      ['trusted-1', { port: {}, readyAt: 100, bridgeId: '7' }],
      ['trusted-2', { port: {}, readyAt: 200, bridgeId: '8' }]
    ])
    assert.equal(findReadyBridgeClient(clients, readyClients).id, 'trusted-2')
  })

  it('drops clients that are no longer active', () => {
    const readyClients = new Map([
      ['stale', {}],
      ['live', {}]
    ])
    pruneReadyClients([{ id: 'live', url: 'https://42.example.com/~~napp' }], readyClients)
    assert.deepEqual([...readyClients.keys()], ['live'])
  })
})
