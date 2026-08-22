import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  findReadyBridgeClient,
  getClientWindowId,
  pruneReadyClients
} from '../../src/helpers/service-worker-bridge-router.js'

describe('service worker bridge router', () => {
  it('prefers the trusted client matching the requesting window id', () => {
    const clients = [
      { id: 'app-1', url: 'https://42.example.com/app?windowId=7' },
      { id: 'trusted-1', url: 'https://42.example.com/~~napp?windowId=7' },
      { id: 'trusted-2', url: 'https://42.example.com/~~napp' }
    ]
    const readyClients = new Map([
      ['trusted-1', { port: {}, windowId: '7' }],
      ['trusted-2', { port: {}, windowId: '' }]
    ])
    assert.equal(findReadyBridgeClient(clients, readyClients, 'app-1').id, 'trusted-1')
  })

  it('drops clients that are no longer active', () => {
    const readyClients = new Map([
      ['stale', {}],
      ['live', {}]
    ])
    pruneReadyClients([{ id: 'live', url: 'https://42.example.com/~~napp' }], readyClients)
    assert.deepEqual([...readyClients.keys()], ['live'])
  })

  it('parses window ids from client urls', () => {
    assert.equal(getClientWindowId({ url: 'https://42.example.com/~~napp?windowId=9' }), '9')
  })
})
