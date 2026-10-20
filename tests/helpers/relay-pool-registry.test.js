import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RelayRegistry } from '#services/relay-pool/registry.js'

describe('relay registry', () => {
  it('normalizes relay URLs and matches ws/wss twins', () => {
    const registry = new RelayRegistry(['wss://relay.example/'])
    assert.equal(registry.hasRelay('wss://relay.example'), true)
    assert.equal(registry.hasRelay('ws://relay.example/'), true)
    assert.equal(registry.hasRelay('wss://other.example'), false)
  })

  it('deduplicates additions and notifies listeners once', () => {
    const registry = new RelayRegistry()
    const updates = []
    registry.subscribe(urls => updates.push(urls))
    assert.equal(registry.addRelay('wss://relay.example/'), true)
    assert.equal(registry.addRelay('wss://relay.example'), false)
    assert.deepEqual(updates, [['wss://relay.example']])
  })

  it('remembers non-relays until the exact TTL boundary', t => {
    let now = 1000
    t.mock.method(Date, 'now', () => now)
    const registry = new RelayRegistry()
    registry.addNonRelay('wss://generic.example', 5)
    assert.equal(registry.isNonRelay('wss://generic.example'), true)
    now += 4
    assert.equal(registry.isNonRelay('wss://generic.example'), true)
    now++
    assert.equal(registry.isNonRelay('wss://generic.example'), false)
  })
})
