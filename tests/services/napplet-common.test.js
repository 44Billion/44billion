import assert from 'node:assert/strict'
import { it } from 'node:test'
import { npubEncode, nprofileEncode, nsecEncode } from 'nostr-tools/nip19'
import { createNappletCommonService } from '#services/napplets/common.js'
import { createNappletSocial } from '#services/napplets/social.js'

const owner = 'ab'.repeat(32)
const other = 'cd'.repeat(32)
const id = 'ef'.repeat(32)
function fixture () {
  const state = { owner, events: [], publications: [], reads: [] }
  const social = createNappletSocial({
    locks: null,
    account: { guard () { if (state.revoked) throw new Error('ACCOUNT_ACCESS_REVOKED') }, getPublicKey: () => state.owner },
    network: {
      router: {
        query: async (filters, options) => { state.reads.push({ filters, options }); return { events: state.events, incomplete: state.incomplete } },
        getEvent: async (eventId, options) => { state.reads.push({ eventId, options }); return { result: state.target } },
        publish: async event => { state.publications.push(event); return { ok: true, event } }
      }
    }
  })
  const service = createNappletCommonService(social)
  const call = (action, args = {}) => new Promise(resolve => service.handleMessage('window', { type: `common.${action}`, id: 'request', ...args }, resolve))
  return { state, social, call }
}

it('round-trips all public NIP-19 types and rejects secrets, corrupt checksums and oversized input', async () => {
  const { call } = fixture()
  for (const input of [
    { type: 'npub', hex: owner }, { type: 'note', hex: id },
    { type: 'nprofile', pubkey: owner, relays: ['wss://relay.example'] },
    { type: 'nevent', eventId: id, author: owner, kind: 1 },
    { type: 'naddr', pubkey: owner, identifier: 'test', kind: 30023 },
    { type: 'nrelay', relay: 'wss://relay.example' }
  ]) {
    const encoded = await call('encodeNip19', { input })
    assert.equal(encoded.ok, true)
    const decoded = await call('decodeNip19', { value: encoded.value })
    assert.equal(decoded.ok, true)
    assert.equal(decoded.nip19Type, input.type)
    const corrupt = encoded.value.slice(0, -1) + (encoded.value.endsWith('q') ? 'p' : 'q')
    assert.equal((await call('decodeNip19', { value: corrupt })).ok, false)
  }
  assert.equal((await call('encodeNip19', { input: { type: 'nsec', hex: owner } })).ok, false)
  for (const value of [nsecEncode(new Uint8Array(32).fill(1)), 'nrelay1' + 'q'.repeat(5000), null]) assert.equal((await call('decodeNip19', { value })).ok, false)
})

it('preserves profile relay results and uses nprofile hints; absence returns null', async () => {
  const { state, call } = fixture()
  const result = { event: { id, created_at: 2, content: '{"name":"Test"}' }, sidecar: { relayHints: ['wss://relay.example'] } }
  state.events = [result]
  const response = await call('getProfile', { target: nprofileEncode({ pubkey: other, relays: ['wss://hint.example'] }) })
  assert.equal(response.pubkey, other)
  assert.deepEqual(response.result, result)
  assert.deepEqual(state.reads[0].options.relays, ['wss://hint.example'])
  state.events = []
  assert.equal((await call('getProfile', { target: other })).profile, null)
})

it('normalizes follows, preserves unrelated state and rejects incomplete replacement writes', async () => {
  const { state, call } = fixture()
  const tags = [['p', owner], ['p', owner], ['p', 'invalid'], ['title', 'Friends']]
  state.events = [{ event: { id, created_at: 1, tags, content: 'retained' } }]
  assert.deepEqual((await call('follows')).pubkeys, [owner])
  assert.equal((await call('follow', { pubkeys: [npubEncode(other), npubEncode(other)] })).ok, true)
  assert.deepEqual(state.publications[0].tags, [...tags, ['p', other]])
  assert.equal(state.publications[0].content, 'retained')
  await call('unfollow', { pubkeys: [npubEncode(owner)] })
  assert.deepEqual(state.publications[1].tags, [['p', 'invalid'], ['title', 'Friends']])
  state.incomplete = true
  assert.equal((await call('follow', { pubkeys: [other] })).ok, false)
  assert.equal(state.publications.length, 2)
  assert.equal((await call('follow', { pubkeys: [] })).ok, false)
})

it('validates reactions before publishing and references addressable targets', async () => {
  const { state, call } = fixture()
  state.target = { event: { id, pubkey: other, kind: 30023, tags: [['d', 'article']] } }
  for (const reaction of ['+', '-', '👍🏽', '👨‍👩‍👧‍👦', '🇧🇷', '1️⃣']) assert.equal((await call('react', { targetEventId: id, reaction })).ok, true)
  assert.ok(state.publications[0].tags.some(tag => tag[0] === 'a' && tag[1] === `30023:${other}:article`))
  const emoji = await call('react', { targetEventId: id, reaction: ':party:', customEmojiHref: 'https://example.com/party.png' })
  assert.deepEqual(emoji.event.tags.at(-1), ['emoji', 'party', 'https://example.com/party.png'])
  const count = state.publications.length
  for (const args of [
    { reaction: 'arbitrary sentence' }, { reaction: '😀😀' }, { reaction: ':party:' },
    { reaction: '+', customEmojiHref: 'https://example.com/e.png' },
    { reaction: ':party:', customEmojiHref: 'javascript:alert(1)' }
  ]) assert.equal((await call('react', { targetEventId: id, ...args })).ok, false)
  assert.equal(state.publications.length, count)
})

it('validates reports, resolves missing authors with hints and supports supplied authors', async () => {
  const { state, call } = fixture()
  assert.equal((await call('report', { target: { type: 'pubkey', pubkey: other }, reason: 'invalid', text: '' })).error, 'invalid-report-reason')
  assert.equal((await call('report', { target: { type: 'unknown' }, reason: 'spam', text: '' })).ok, false)
  state.target = { event: { id, pubkey: other } }
  const response = await call('report', { target: { type: 'event', id, relay: 'wss://hint.example' }, reason: 'spam', text: 'Report text' })
  assert.deepEqual(response.event.tags, [['e', id, 'spam'], ['p', other, 'spam']])
  assert.deepEqual(state.reads[0].options, { relays: ['wss://hint.example'] })
  state.target = undefined
  assert.equal((await call('report', { target: { type: 'event', id }, reason: 'spam', text: '' })).error, 'author-unresolved')
  assert.equal((await call('report', { target: { type: 'event', id, pubkey: other }, reason: 'spam', text: '' })).ok, true)
  const pubkey = await call('report', { target: { type: 'pubkey', pubkey: npubEncode(other) }, reason: 'other', text: '' })
  assert.deepEqual(pubkey.event.tags, [['p', other, 'other']])
})

it('rejects unsigned modifications and revoked requests without publishing', async () => {
  const { state, call } = fixture()
  state.owner = null
  for (const [action, args] of [['follow', { pubkeys: [other] }], ['unfollow', { pubkeys: [other] }], ['react', { targetEventId: id, reaction: '+' }], ['report', { target: { type: 'pubkey', pubkey: other }, reason: 'spam', text: '' }]]) assert.equal((await call(action, args)).error, 'not-signed-in')
  assert.equal(state.publications.length, 0)
  state.owner = owner
  state.revoked = true
  assert.equal((await call('getProfile', { target: other })).error, 'ACCOUNT_ACCESS_REVOKED')
  assert.equal((await call('follow', { pubkeys: [other] })).error, 'ACCOUNT_ACCESS_REVOKED')
  assert.equal(state.publications.length, 0)
})
