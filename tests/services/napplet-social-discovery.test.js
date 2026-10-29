import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createNappletSocial } from '#services/napplets/social.js'

it('uses partial server-list results only when explicitly requested, retaining strict mutation reads', async () => {
  const event = { id: 'id', created_at: 1, tags: [['server', 'https://preferred.example']] }
  let response = { incomplete: true, events: [{ event }] }
  const social = createNappletSocial({
    account: { guard () {}, getPublicKey: () => 'pubkey' },
    network: { router: { query: async () => response } }
  })
  assert.equal(await social.latest(10063, 'pubkey', { allowIncomplete: true }), event)
  await assert.rejects(social.latest(10063), /INCOMPLETE_PUBLIC_STATE/)
  await assert.rejects(social.follow(['ab'.repeat(32)]), /INCOMPLETE_PUBLIC_STATE/)
  response = { error: 'GET_EVENTS_TIMEOUT' }
  assert.equal(await social.latest(10063, 'pubkey', { allowIncomplete: true }), null)
  await assert.rejects(social.latest(10063), /GET_EVENTS_TIMEOUT/)
})
