import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getProfileEventsByPubkey } from '#helpers/nostr-queries.js'

describe('publisher profile queries', () => {
  it('batches unresolved authors across remaining write relays and at most three free relays', async () => {
    const pubkeys = ['7'.repeat(64), '8'.repeat(64)]
    const relays = [
      'wss://primary-one.test',
      'wss://primary-two.test',
      'wss://remaining.test'
    ]
    const freeRelayCandidates = [
      'wss://free-one.test',
      'wss://free-two.test',
      'wss://free-three.test',
      'wss://free-four.test'
    ]
    const calls = []

    const events = await getProfileEventsByPubkey(pubkeys, {
      _nostrRelays: {
        async getEvents (filter, selectedRelays) {
          calls.push({ authors: filter.authors, relay: selectedRelays[0] })
          if (selectedRelays[0] !== 'wss://remaining.test') return { result: [] }
          return {
            result: pubkeys.map((pubkey, index) => ({
              id: String(index + 1).repeat(64),
              kind: 0,
              pubkey,
              created_at: 1,
              tags: [],
              content: JSON.stringify({ name: `Author ${index + 1}` })
            }))
          }
        }
      },
      async _getUserRelays () {
        return Object.fromEntries(pubkeys.map(pubkey => [pubkey, { write: relays }]))
      },
      _freeRelays: freeRelayCandidates
    })

    assert.deepEqual(calls.map(call => call.relay), [
      ...relays,
      ...freeRelayCandidates.slice(0, 3)
    ])
    calls.forEach(call => assert.deepEqual(call.authors, pubkeys))
    assert.deepEqual(events.map(event => event.pubkey), pubkeys)
  })

  it('falls back to public relays when NIP-65 discovery fails', async () => {
    const pubkey = '9'.repeat(64)
    const calls = []
    const events = await getProfileEventsByPubkey([pubkey], {
      async _getUserRelays () {
        throw new Error('relay discovery unavailable')
      },
      _nostrRelays: {
        async getEvents (filter, selectedRelays) {
          calls.push({ authors: filter.authors, relay: selectedRelays[0] })
          return { result: [] }
        }
      },
      _freeRelays: [
        'wss://free-one.test',
        'wss://free-two.test',
        'wss://free-three.test',
        'wss://free-four.test'
      ]
    })

    assert.deepEqual(calls.map(call => call.relay), [
      'wss://free-one.test',
      'wss://free-two.test',
      'wss://free-three.test'
    ])
    calls.forEach(call => assert.deepEqual(call.authors, [pubkey]))
    assert.deepEqual(events, [])
  })
})
