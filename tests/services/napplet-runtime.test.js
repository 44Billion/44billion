import assert from 'node:assert/strict'
import { it } from 'node:test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { base16ToBase62 } from 'libp2r2p/base62'
import { createNappletAccount } from '#services/napplets/account.js'
import { createNappletNetwork } from '#services/napplets/network.js'
import { createNappletResourceResolver, classifyResource, MAX_RESOURCE_BYTES } from '#services/napplets/resources.js'
import { createNappletLists } from '#services/napplets/lists.js'

function accountFixture () {
  const key = generateSecretKey()
  const pubkey = getPublicKey(key)
  const userPk = base16ToBase62(pubkey, { mode: 'integer', minLength: 43 })
  const records = new Map(Object.entries({ session_workspaceByKey_ws_userPk: userPk, session_defaultUserPk: 'guest' }).map(([key, value]) => [key, JSON.stringify(value)]))
  const storage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) }
  const controller = new AbortController()
  return { key, pubkey, userPk, storage, controller }
}

it('signs through launcher permissions/vault and rechecks account access after permission waits', async () => {
  const fixture = accountFixture()
  let permissions = 0
  let vaultCalls = 0
  const options = {
    ...fixture, appId: `napplet-${'ab'.repeat(32)}`, wsKey: 'ws', signal: fixture.controller.signal,
    requestPermission: async () => { permissions++ },
    askVault: async message => { vaultCalls++; assert.equal(message.code, 'NIP07'); assert.equal(message.payload.method, 'sign_event'); return { payload: finalizeEvent(message.payload.params[0], fixture.key) } }
  }
  const account = createNappletAccount(options)
  const template = { kind: 1, created_at: 1, content: 'Signed with consent', tags: [] }
  assert.equal((await account.signEvent(template)).pubkey, fixture.pubkey)
  assert.equal(permissions, 1)
  assert.equal(vaultCalls, 1)
  const revoked = createNappletAccount({ ...options, requestPermission: async () => fixture.storage.setItem('session_workspaceByKey_ws_userPk', JSON.stringify('other')) })
  await assert.rejects(revoked.signEvent(template), /REVOKED/)
  assert.equal(vaultCalls, 1)
})

it('rejects read-only signing before prompts and permits public identity reads', async () => {
  const fixture = accountFixture()
  fixture.storage.setItem(`session_accountByUserPk_${fixture.userPk}_isReadOnly`, 'true')
  const account = createNappletAccount({ ...fixture, appId: 'app', wsKey: 'ws', signal: fixture.controller.signal, askVault: () => assert.fail('vault must not run'), requestPermission: () => assert.fail('prompt must not run') })
  assert.equal(account.getPublicKey(), fixture.pubkey)
  await assert.rejects(account.signEvent({ kind: 1, created_at: 1, content: '', tags: [] }), /READ_ONLY_ACCOUNT/)
})

it('adapts real pool feed/result shapes, verifies reads, waits for publication and uses COUNT without event downloads', async () => {
  const key = generateSecretKey()
  const event = finalizeEvent({ kind: 1, created_at: 1, content: '', tags: [] }, key)
  let closed = false
  let countCalls = 0
  const controller = new AbortController()
  const network = createNappletNetwork({
    signal: controller.signal,
    account: { guard: () => controller.signal.throwIfAborted(), getPublicKey: () => event.pubkey, signEvent: async template => finalizeEvent(template, key) },
    loadRelays: async keys => Object.fromEntries(keys.map(key => [key, { read: ['wss://relay.example.com'], write: ['wss://relay.example.com'] }])),
    pool: {
      async * getEventsFeedGenerator () { try { yield { type: 'event', event }; yield { type: 'eose' } } finally { closed = true } },
      sendEvent: async (_event, urls) => ({ promise: Promise.resolve({ succeededRelays: urls, success: true }) }),
      countEvents: async () => { countCalls++; return { success: true, count: 12, approximate: false } }
    }
  })
  const result = await network.router.query([{ kinds: [1], authors: [event.pubkey] }])
  assert.equal(result.events[0].event.id, event.id)
  assert.equal(closed, true)
  const published = await network.router.publish({ kind: 1, created_at: 2, content: 'new', tags: [] })
  assert.equal(published.ok, true)
  assert.equal((await network.count([{ kinds: [1], authors: [event.pubkey] }])).count, 12)
  assert.equal(countCalls, 1)
  assert.equal((await network.count([{ kinds: [1] }, { kinds: [2] }])).ok, false)
  network.close()
})

it('mediates public resources, strips ambient credentials, classifies bytes and enforces size limits', async () => {
  const controller = new AbortController()
  const resolve = createNappletResourceResolver({
    signal: controller.signal, fetchBytes: async (url, options) => {
      assert.equal(url, 'https://example.com/data')
      assert.equal(options.credentials, 'omit')
      assert.equal(options.redirect, 'error')
      return new Response('{"ok":true}', { headers: { 'content-type': 'image/png' } })
    }
  })
  const response = await resolve('https://example.com/data', { method: 'GET' })
  assert.equal(response.headers.get('content-type'), 'application/json')
  await assert.rejects(resolve('http://127.0.0.1/private', { method: 'GET' }), /public/)
  const huge = createNappletResourceResolver({ signal: controller.signal, fetchBytes: async () => new Response('x', { headers: { 'content-length': String(MAX_RESOURCE_BYTES + 1) } }) })
  await assert.rejects(huge('https://example.com/data', { method: 'GET' }), /16 MiB/)
  assert.equal(classifyResource(new Uint8Array([255, 216, 255])), 'image/jpeg')
})

it('mutates public lists without destroying private content and refuses incomplete reads', async () => {
  const existing = { content: 'encrypted private items', tags: [['d', 'friends'], ['p', 'ab'.repeat(32)], ['title', 'Friends']], created_at: 1, id: 'ab'.repeat(32) }
  let published
  let incomplete = false
  const lists = createNappletLists({
    account: { getPublicKey: () => 'cd'.repeat(32), guard: () => {} }, locks: null,
    network: {
      router: {
        query: async () => ({ events: [{ event: existing }], incomplete }),
        publish: async template => { published = template; return { ok: true } }
      }
    }
  })
  const item = { itemType: 'pubkey', value: 'ef'.repeat(32) }
  assert.equal((await lists.add({ kind: 30000, identifier: 'friends' }, [item])).ok, true)
  assert.equal(published.content, existing.content)
  assert.ok(published.tags.some(tag => tag[0] === 'title'))
  assert.equal((await lists.add({ kind: 30000, identifier: 'friends' }, [{ ...item, visibility: 'private' }])).error, 'private-items-unsupported')
  incomplete = true
  assert.equal((await lists.remove({ kind: 30000, identifier: 'friends' }, [item])).error, 'list-unavailable')
})

it('does not turn failed relay snapshots into EOSE and cancels active subscriptions', async () => {
  const controller = new AbortController()
  const messages = []
  let cancelled = false
  const network = createNappletNetwork({
    signal: controller.signal,
    account: { guard () {}, getPublicKey: () => null }, loadRelays: async () => ({}),
    pool: {
      async * getEventsFeedGenerator (_filter, _urls, { signal }) {
        try {
          yield { type: 'eose', relays: [{ status: 'timeout' }] }
          await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
        } finally { cancelled = true }
      }
    }
  })
  network.subscribe([{ kinds: [3] }], ['wss://relay.example.com'], value => messages.push(value))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(messages, [])
  network.close()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true)
})

it('isolates shared OS media actions and teardown between app frames', async () => {
  const { scopedMediaBridge } = await import('#services/napplets/media.js')
  const handlers = new Map()
  const host = { document: null, navigator: { mediaSession: { metadata: null, playbackState: 'none', setActionHandler: (action, callback) => handlers.set(action, callback) } } }
  const first = scopedMediaBridge('first', host)
  const second = scopedMediaBridge('second', host)
  const received = []
  const stopFirst = first.onAction(() => assert.fail('inactive owner received action'))
  const stopSecond = second.onAction((id, action) => received.push([id, action]))
  first.setMetadata('same-id', { title: 'First' })
  first.setActiveSession('same-id', ['play'])
  second.setMetadata('same-id', { title: 'Second' })
  second.setActiveSession('same-id', ['play'])
  first.destroySession('same-id')
  first.setActiveSession(null)
  handlers.get('play')()
  assert.deepEqual(received, [['same-id', 'play']])
  second.destroySession('same-id')
  second.setActiveSession(null)
  stopFirst()
  stopSecond()
})

it('reports OUTBOX success when any destination accepts and preserves individual failures', async () => {
  const key = generateSecretKey()
  const urls = ['wss://one.example', 'wss://two.example']
  let accepted = [urls[0]]
  let signs = 0
  const network = createNappletNetwork({
    signal: new AbortController().signal,
    account: { guard () {}, getPublicKey: () => getPublicKey(key), signEvent: async template => { signs++; return finalizeEvent(template, key) } },
    loadRelays: async keys => Object.fromEntries(keys.map(key => [key, { read: urls, write: urls }])),
    pool: { sendEvent: async () => ({ promise: Promise.resolve({ succeededRelays: accepted }) }) }
  })
  const template = { kind: 1, content: 'partial delivery', tags: [], created_at: 1 }
  const partial = await network.router.publish(template, { toInboxes: [getPublicKey(key)] })
  assert.equal(partial.ok, true)
  assert.equal(partial.error, undefined)
  assert.deepEqual(partial.relays, { [urls[0]]: true, [urls[1]]: false })
  assert.equal(partial.eventId, partial.event.id)
  assert.equal(signs, 1)
  accepted = []
  const failed = await network.router.publish(template)
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'PUBLICATION_FAILED')
  network.close()
})

it('preserves signer refusals without attempting publication', async () => {
  const network = createNappletNetwork({
    signal: new AbortController().signal,
    account: { guard () {}, getPublicKey: () => 'ab'.repeat(32), signEvent: async () => { throw new Error('SIGNATURE_DENIED') } },
    pool: { sendEvent: () => assert.fail('must not publish') }
  })
  assert.deepEqual(await network.router.publish({ kind: 1, content: '', tags: [], created_at: 1 }), { ok: false, error: 'SIGNATURE_DENIED' })
  network.close()
})
