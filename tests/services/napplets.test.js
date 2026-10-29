import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { nappletDescriptor, nappletReference, decodeNappletReference, nappletReferenceFromHref } from '#helpers/napplet.js'
import { installNapplet, loadNapplet, resolveNappletReference, queryNappletCatalog } from '#services/napplets/index.js'
import { getInstallation, saveInstallation, createNappletStatePersistence, nappletStateKey, clearNappletState } from '#services/napplets/storage.js'
import { auditPersistedState } from '#services/storage-audit/audit.js'
import { addressObjToAppId } from '#helpers/app.js'

function fixture ({ kind = 35129, key = generateSecretKey(), html = '<!doctype html><p>Hello</p>', requires = [], dTag = 'example' } = {}) {
  const bytes = new TextEncoder().encode(html)
  const event = finalizeEvent({
    kind, created_at: 1, content: 'A sandboxed test napplet',
    tags: [...(kind === 35129 ? [['d', dTag]] : []), ['title', 'Example'], ['x', bytesToHex(sha256(bytes))], ...requires.map(domain => ['R', domain])]
  }, key)
  return { event, bytes }
}

function storageMock () {
  const values = new Map()
  return {
    get length () { return values.size }, key: index => [...values.keys()][index],
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)
  }
}

describe('napplet installation', () => {
  it('keeps publisher/kind identity separate from artifact versions and existing next-channel IDs', () => {
    const key = generateSecretKey()
    const first = fixture({ key })
    const second = fixture({ key, html: '<p>New build</p>' })
    const descriptor = nappletDescriptor(first.event)
    assert.equal(descriptor.appId, nappletDescriptor(second.event).appId)
    assert.notEqual(descriptor.appId, nappletDescriptor(fixture().event).appId)
    assert.notEqual(descriptor.appId, addressObjToAppId({ kind: 35129, pubkey: first.event.pubkey, dTag: 'example' }))
    assert.notEqual(descriptor.appId, nappletDescriptor(fixture({ key, kind: 15129 }).event).appId)
    assert.notEqual(nappletDescriptor(fixture({ key, kind: 5129 }).event).appId, nappletDescriptor(fixture({ key, kind: 5129, html: '<p>Snapshot</p>' }).event).appId)
  })

  it('round-trips named, root and exact snapshot references without changing napp URLs', () => {
    for (const kind of [35129, 15129, 5129]) {
      const { event } = fixture({ kind })
      const reference = nappletReference(event)
      const decoded = decodeNappletReference(reference)
      assert.equal(kind === 5129 ? decoded.filter.ids[0] : decoded.filter.authors[0], kind === 5129 ? event.id : event.pubkey)
      assert.equal(nappletReferenceFromHref(`/napplet/${reference}`), reference)
      assert.equal(nappletReferenceFromHref(`/${reference}`), null)
    }
    assert.throws(() => decodeNappletReference('npub1invalid'))
  })

  it('rejects unsigned, altered and legacy aggregate manifests while treating required NAPs as hints', async () => {
    const idb = new IDBFactory()
    const { event } = fixture()
    const altered = JSON.parse(JSON.stringify(event))
    altered.content = 'Altered'
    assert.throws(() => nappletDescriptor(altered), /signature/)
    const { event: unsupported, bytes } = fixture({ requires: ['outbox'] })
    const appId = await installNapplet(unsupported, { idb, fetchBlob: async () => bytes })
    assert.equal((await loadNapplet(appId, { idb })).manifest.requires[0], 'outbox')
    const legacy = finalizeEvent({ kind: 35129, created_at: 1, content: '', tags: [['d', 'example'], ['x', 'ab'.repeat(32), 'aggregate'], ['path', '/index.html', 'cd'.repeat(32)]] }, generateSecretKey())
    assert.throws(() => nappletDescriptor(legacy))
  })

  it('validates catalog entries and never accepts an unrelated signed event for a reference', async () => {
    const idb = new IDBFactory()
    const { event } = fixture()
    const unrelated = fixture({ requires: ['dm'] }).event
    const invalid = { ...JSON.parse(JSON.stringify(event)), sig: '00'.repeat(64) }
    const pool = { getEvents: async () => ({ success: true, result: [invalid, unrelated, event].map(event => ({ event })) }) }
    const catalog = await queryNappletCatalog({ pool })
    assert.equal(catalog.length, 2)
    assert.deepEqual(catalog.find(entry => entry.event.id === unrelated.id).missing, ['dm'])
    assert.equal((await resolveNappletReference(nappletReference(event), { idb, pool })).event.id, event.id)
    await assert.rejects(resolveNappletReference(nappletReference(fixture().event), { idb, pool }), /No valid napplet/)
  })

  it('persists verified bytes, reopens offline and stays on the installed coordinate version', async () => {
    const idb = new IDBFactory()
    const key = generateSecretKey()
    for (const kind of [35129, 15129, 5129]) {
      const { event, bytes } = fixture({ key, kind })
      const appId = await installNapplet(event, { idb, fetchBlob: async () => bytes })
      assert.equal((await loadNapplet(appId, { idb })).indexHtml, new TextDecoder().decode(bytes))
      assert.equal((await resolveNappletReference(nappletReference(event), { idb })).event.id, event.id)
      if (kind !== 5129) {
        const next = fixture({ key, kind, html: '<p>New version</p>' })
        await installNapplet(next.event, { idb, fetchBlob: () => assert.fail('opening must not update') })
        assert.equal((await getInstallation(appId, idb)).event.id, event.id)
      }
    }
  })

  it('never commits corrupt bytes and rechecks persisted bytes before execution', async () => {
    const idb = new IDBFactory()
    const { event, bytes } = fixture()
    const { appId } = nappletDescriptor(event)
    await assert.rejects(installNapplet(event, { idb, fetchBlob: async () => new Uint8Array([1]) }))
    assert.equal(await getInstallation(appId, idb), undefined)
    await installNapplet(event, { idb, fetchBlob: async () => bytes })
    const record = await getInstallation(appId, idb)
    record.blobs[0][1] = new Uint8Array([1])
    await saveInstallation(record, idb)
    await assert.rejects(loadNapplet(appId, { idb }))
  })

  it('retains one complete release when two tabs install the same coordinate concurrently', async () => {
    const idb = new IDBFactory()
    const key = generateSecretKey()
    const first = fixture({ key })
    const second = fixture({ key, html: '<p>A different release</p>' })
    const ids = await Promise.all([first, second].map(({ event, bytes }) => installNapplet(event, { idb, fetchBlob: async () => bytes })))
    assert.equal(ids[0], ids[1])
    const record = await getInstallation(ids[0], idb)
    const selected = record.event.id === first.event.id ? first : second
    assert.equal((await loadNapplet(ids[0], { idb })).indexHtml, new TextDecoder().decode(selected.bytes))
  })

  it('isolates persisted state across accounts, publishers and versions, including adversarial keys', () => {
    const storage = storageMock()
    const appId = nappletDescriptor(fixture().event).appId
    const first = createNappletStatePersistence('alice', appId, storage)
    assert.equal(first.set('__proto__', 'safe'), true)
    assert.equal(first.set('version-one:value', 'remember me'), true)
    assert.equal(createNappletStatePersistence('alice', appId, storage).get('version-one:value'), 'remember me')
    assert.equal(createNappletStatePersistence('bob', appId, storage).get('version-one:value'), null)
    assert.equal(createNappletStatePersistence('alice', nappletDescriptor(fixture().event).appId, storage).get('version-one:value'), null)
    assert.equal(first.get('version-two:value'), null)
    first.clear('version-one:')
    assert.equal(first.get('version-one:value'), null)
    assert.equal(first.get('__proto__'), 'safe')
    storage.setItem(nappletStateKey('bob', appId), '{invalid')
    const audit = auditPersistedState(storage, storageMock())
    assert.equal(audit.plan.local[nappletStateKey('bob', appId)], null)
    assert.equal(audit.plan.local[nappletStateKey('alice', appId)], undefined)
    clearNappletState(appId, storage, 'alice')
    assert.equal(storage.getItem(nappletStateKey('alice', appId)), null)
    assert.notEqual(storage.getItem(nappletStateKey('bob', appId)), null)
    clearNappletState(appId, storage)
    assert.equal(storage.getItem(nappletStateKey('bob', appId)), null)
  })
})
