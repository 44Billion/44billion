import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, isValidEvent } from 'libp2r2p/event'
import { createEventVerifier, verificationBackend, verifyEvent } from '../../src/services/event-verification.js'

const key = new Uint8Array(32).fill(1)
const signed = (content = 'Hello 🌍\n"\\\u0000') => finalizeEvent({ kind: 1, created_at: 123, tags: [['t', '日本語']], content }, key)

test('WASM verifies signed events and rejects tampering without trusting cached verification', () => {
  assert.equal(verificationBackend, 'wasm')
  const event = signed()
  assert.equal(verifyEvent(event), true)
  event.content += 'changed'
  assert.equal(verifyEvent(event), false)
  for (const field of ['id', 'sig', 'pubkey']) {
    const changed = signed()
    changed[field] = '0'.repeat(changed[field].length)
    assert.equal(verifyEvent(changed), false, field)
  }
})

test('WASM and JavaScript agree on malformed events', () => {
  const event = signed()
  const cases = [null, {}, [], ...[
    { id: '' }, { id: event.id.toUpperCase() }, { sig: '' }, { sig: 'x'.repeat(128) },
    { pubkey: 'x'.repeat(64) }, { kind: -1 }, { kind: 65536 },
    { created_at: 1.5 }, { created_at: Number.MAX_SAFE_INTEGER + 1 },
    { tags: [[]] }, { tags: [['t', 1]] }, { content: null }
  ].map(patch => ({ ...event, ...patch }))]
  for (const candidate of cases) assert.equal(verifyEvent(candidate), isValidEvent(candidate))
})

test('initialization failure retains strict JavaScript verification', async () => {
  const fallback = await createEventVerifier(async () => { throw new Error('WASM unavailable') })
  assert.equal(fallback.backend, 'javascript')
  const event = signed()
  assert.equal(fallback.verifyEvent(event), true)
  event.tags[0][1] = 'tampered'
  assert.equal(fallback.verifyEvent(event), false)
})

test('large payloads avoid the fixed WASM heap', async () => {
  const verifier = await createEventVerifier(async () => ({ verifyEvent () { throw new Error('must not use WASM') } }))
  assert.equal(verifier.verifyEvent(signed('a'.repeat(300 * 1024))), true)
})
