import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isStrictNostrFrame, parseNostrFrame } from '#services/relay-pool/classify.js'

const event = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  sig: 'c'.repeat(128),
  kind: 1,
  created_at: 1,
  tags: [],
  content: 'hello'
}

const frame = value => JSON.stringify(value)

describe('Nostr frame classification', () => {
  it('accepts strict client and server frames from NIP-01/42/45/77', () => {
    const clientFrames = [
      ['REQ', 'sub1', { kinds: [1] }],
      ['CLOSE', 'sub1'],
      ['EVENT', event],
      ['COUNT', 'sub1', { kinds: [1] }],
      ['AUTH', { ...event, kind: 22242 }],
      ['NEG-OPEN', 'sub1', { kinds: [1] }, 'aa'],
      ['NEG-MSG', 'sub1', 'payload'],
      ['NEG-CLOSE', 'sub1']
    ]
    for (const value of clientFrames) assert.equal(isStrictNostrFrame(frame(value), 'client'), true, value[0])
    const serverFrames = [
      ['EVENT', 'sub1', event],
      ['EOSE', 'sub1'],
      ['CLOSED', 'sub1', 'auth-required: no'],
      ['OK', event.id, true, 'saved'],
      ['NOTICE', 'hello'],
      ['AUTH', 'challenge'],
      ['COUNT', 'sub1', { count: 2 }],
      ['NEG-MSG', 'sub1', 'payload'],
      ['NEG-ERR', 'sub1', 'blocked']
    ]
    for (const value of serverFrames) assert.equal(isStrictNostrFrame(frame(value), 'server'), true, value[0])
  })

  it('rejects generic protocols, malformed frames and binary data', () => {
    const rejected = [
      ['REQ', 1, { kinds: [1] }],
      ['REQ', 'sub1'],
      ['REQ', 'sub1', 'not-a-filter'],
      ['EVENT', { ...event, kind: '1' }],
      ['AUTH', event],
      ['NEG-OPEN', 'sub1', { kinds: [1] }],
      ['PING', 'x'],
      { hello: 'world' },
      'not json'
    ]
    for (const value of rejected) {
      assert.equal(isStrictNostrFrame(typeof value === 'string' ? value : frame(value), 'client'), false, JSON.stringify(value))
    }
    assert.equal(isStrictNostrFrame(new Uint8Array([1, 2, 3]), 'server'), false)
    assert.equal(isStrictNostrFrame(frame(['COUNT', 'sub1', { count: -1 }]), 'server'), false)
  })

  it('parses only JSON arrays with a string op', () => {
    assert.deepEqual(parseNostrFrame(frame(['REQ', 'sub1', {}])), ['REQ', 'sub1', {}])
    assert.equal(parseNostrFrame('{"a":1}'), null)
    assert.equal(parseNostrFrame('not json'), null)
    assert.equal(parseNostrFrame(new ArrayBuffer(1)), null)
  })
})

it('recognizes CLOSED with optional structured retry metadata', () => {
  assert.equal(isStrictNostrFrame(JSON.stringify(['CLOSED', 'sub', 'rate-limited: busy', { retry_after: 2 }]), 'server'), true)
  assert.equal(isStrictNostrFrame(JSON.stringify(['CLOSED', 'sub', 'rate-limited: busy', 'bad']), 'server'), false)
})
