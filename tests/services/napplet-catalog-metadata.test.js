import assert from 'node:assert/strict'
import { it } from 'node:test'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { createNappletIconUrl, loadNappletAuthors, nappletAuthorLabel, MAX_NAPPLET_ICON_BYTES } from '#services/napplets/catalog-metadata.js'

it('uses the latest signed author name and rejects unrelated or altered profiles', async () => {
  const key = generateSecretKey()
  const profile = (createdAt, content) => finalizeEvent({ kind: 0, created_at: createdAt, content: JSON.stringify(content), tags: [] }, key)
  const old = profile(1, { name: 'Old' })
  const current = profile(2, { name: 'Name', display_name: 'Publisher' })
  const invalid = { ...JSON.parse(JSON.stringify(current)), content: '{"display_name":"Forged"}' }
  const profiles = await loadNappletAuthors([current.pubkey], { fetchProfiles: async () => [old, invalid, current] })
  assert.equal(nappletAuthorLabel(current.pubkey, profiles), 'Publisher')
  assert.match(nappletAuthorLabel(current.pubkey), /^npub1.*…/)
  assert.deepEqual(await loadNappletAuthors(['ab'.repeat(32)], { fetchProfiles: async () => [current] }), {})
})

it('verifies icon hash, supported raster type, byte budget and decoded dimensions before displaying it', async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
  const manifest = { icon: { sha256: bytesToHex(sha256(bytes)), mimeType: 'image/png' }, servers: [] }
  let closed = 0
  const options = { fetchBlob: async () => bytes, decode: async () => ({ width: 64, height: 64, close: () => closed++ }), createUrl: () => 'blob:verified' }
  assert.equal(await createNappletIconUrl(manifest, options), 'blob:verified')
  assert.equal(closed, 1)
  await assert.rejects(createNappletIconUrl(manifest, { ...options, fetchBlob: async () => new Uint8Array([1]) }), /Invalid/)
  await assert.rejects(createNappletIconUrl({ ...manifest, icon: { ...manifest.icon, mimeType: 'image/jpeg' } }, options), /Invalid/)
  await assert.rejects(createNappletIconUrl(manifest, { ...options, fetchBlob: async () => new Uint8Array(MAX_NAPPLET_ICON_BYTES + 1) }), /Invalid/)
  await assert.rejects(createNappletIconUrl(manifest, { ...options, decode: async () => ({ width: 2049, height: 64, close: () => closed++ }) }), /dimensions/)
  assert.equal(closed, 2)
})
