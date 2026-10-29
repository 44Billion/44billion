import assert from 'node:assert/strict'
import { it } from 'node:test'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { createNappletIntentCoordinator, nappletIntentEntry } from '#services/napplets/intents.js'
import { nappletDescriptor } from '#helpers/napplet.js'
import { auditPersistedState } from '#services/storage-audit/audit.js'

function manifest (tags = []) {
  return finalizeEvent({ kind: 35129, created_at: 1, content: 'Intent fixture', tags: [['d', 'fixture'], ['x', 'ab'.repeat(32)], ...tags] }, generateSecretKey())
}
const contract = [['z', 'profile'], ['i', 'napplet:profile/open', 'pubkey']]
function fixture () {
  const source = manifest()
  const target = manifest(contract)
  const records = [source, target].map(event => ({ event, appId: nappletDescriptor(event).appId }))
  const values = new Map(Object.entries({ session_workspaceByKey_ws_userPk: 'alice', session_workspaceByKey_ws_pinnedAppIds: records.map(record => record.appId), session_workspaceByKey_ws_unpinnedAppIds: [] }).map(([key, value]) => [key, JSON.stringify(value)]))
  const storage = { get length () { return values.size }, key: i => [...values.keys()][i], getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const opened = []; const deliveries = []; const errors = []; const discoveries = []
  const options = { wsKey: 'ws', userPk: 'alice', storage, installations: async () => records, openTarget: async (...args) => { opened.push(args); return 'target' }, choose: async ({ candidates }) => candidates[0]?.id, find: handoff => discoveries.push(handoff), reportError: error => errors.push(error) }
  const coordinator = createNappletIntentCoordinator(options)
  const endpoint = (event, appKey, windowId = appKey) => coordinator.service({ event, appKey, windowId, send: message => deliveries.push(message), guard () { assert.equal(JSON.parse(storage.getItem('session_workspaceByKey_ws_userPk')), 'alice') } })
  const caller = endpoint(source, 'source')
  const invoke = request => new Promise(resolve => caller.service.handleMessage('source', { type: 'intent.invoke', id: 'rpc', request: { archetype: 'profile', action: 'open', convention: 'napplet:profile/open', ...request } }, message => resolve(message.result)))
  return { ...options, coordinator, caller, endpoint, invoke, source, target, records, opened, deliveries, errors, discoveries }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

it('extracts only exact current z/i contracts from verified manifests of all kinds', () => {
  const event = manifest([...contract, ['i', 'napplet:profile/open?x=1'], ['i', 'napplet:other/open'], ['archetype', 'legacy', 'napplet:legacy/open']])
  assert.deepEqual(nappletIntentEntry(event).archetypes.profile.contracts, [{ convention: 'napplet:profile/open', params: ['pubkey'] }])
  assert.equal(nappletIntentEntry(event).archetypes.other, undefined)
  assert.equal(nappletIntentEntry(event).archetypes.legacy, undefined)
  assert.throws(() => nappletIntentEntry(JSON.parse(JSON.stringify({ ...event, content: 'tampered' }))))
})

it('accepts cold-start delivery, attests sender and retains payload after the source closes', async () => {
  const f = fixture()
  const result = await f.invoke({ payload: { pubkey: 'abc', nested: [1] } })
  assert.equal(result.ok, true)
  f.caller.close()
  await tick()
  assert.equal(f.opened.length, 1)
  assert.equal(f.deliveries.length, 0)
  const target = f.endpoint(f.target, 'target')
  target.ready()
  assert.deepEqual(f.deliveries, [{ type: 'intent.deliver', delivery: { sender: nappletDescriptor(f.source).catalogId, archetype: 'profile', action: 'open', convention: 'napplet:profile/open', payload: { pubkey: 'abc', nested: [1] } } }])
  target.ready()
  assert.equal(f.deliveries.length, 1)
  target.close()
})

it('delivers to an already ready target and preserves reuse/focus behavior hints', async () => {
  const f = fixture()
  const target = f.endpoint(f.target, 'target')
  target.ready()
  assert.equal((await f.invoke({ behavior: { reuse: false, focus: false } })).ok, true)
  await tick()
  assert.deepEqual(f.opened[0][1], { reuse: false, focus: false })
  assert.equal(f.deliveries.length, 1)
  f.caller.close(); target.close()
})

it('rejects forged senders and inconsistent/query conventions before startup', async () => {
  const f = fixture()
  for (const request of [{ sender: 'forged' }, { action: 'edit' }, { convention: 'napplet:profile/open?pubkey=abc' }]) assert.equal((await f.invoke(request)).ok, false)
  assert.equal(f.opened.length, 0)
  assert.equal(f.discoveries.length, 0)
  f.caller.close()
})

it('discovers only after no installed match and lets an explicit store continuation deliver', async () => {
  const f = fixture()
  const record = f.records.pop()
  assert.deepEqual(await f.invoke({ payload: { pubkey: 'private' } }), { ok: false, error: 'no handler' })
  assert.equal(f.discoveries.length, 1)
  assert.equal(f.opened.length, 0)
  f.caller.close()
  f.records.push(record)
  const target = f.endpoint(f.target, 'target'); target.ready()
  await f.discoveries[0].continue(nappletDescriptor(f.target).catalogId)
  assert.equal(f.deliveries[0].delivery.payload.pubkey, 'private')
  target.close()
})

it('rechecks workspace ownership before delivery and never sends into another account', async () => {
  const f = fixture()
  assert.equal((await f.invoke()).ok, true)
  await tick()
  f.storage.setItem('session_workspaceByKey_ws_userPk', '"bob"')
  const target = f.endpoint(f.target, 'target'); target.ready()
  await tick()
  assert.equal(f.deliveries.length, 0)
  assert.equal(f.errors.length, 1)
  f.caller.close(); target.close()
})

it('keeps user defaults outside app state and storage audit removes malformed defaults only', () => {
  const f = fixture()
  f.coordinator.setDefault('profile', nappletDescriptor(f.target).catalogId)
  assert.equal(JSON.parse(f.storage.getItem('local_nappletIntentDefaults')).alice.profile, nappletDescriptor(f.target).catalogId)
  f.coordinator.setDefault('profile')
  assert.deepEqual(JSON.parse(f.storage.getItem('local_nappletIntentDefaults')).alice, {})
  f.storage.setItem('local_nappletIntentDefaults', '{"alice":{"profile":3}}')
  const audit = auditPersistedState(f.storage, { length: 0, key () {} })
  assert.ok(JSON.stringify(audit).includes('invalid_napplet_intent_defaults'))
  f.caller.close()
})

it('times out accepted startup once, without delivering or sending a second invocation result', async () => {
  const f = fixture()
  const errors = []
  const coordinator = createNappletIntentCoordinator({ ...f, timeoutMs: 10, reportError: error => errors.push(error) })
  const source = coordinator.service({ event: f.source, appKey: 'source', windowId: 'source', send () {}, guard () {} })
  const responses = []
  source.service.handleMessage('source', { type: 'intent.invoke', id: 'timeout', request: { archetype: 'profile', action: 'open', convention: 'napplet:profile/open' } }, message => responses.push(message))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(responses.length, 1)
  assert.equal(responses[0].result.ok, true)
  assert.equal(errors.length, 1)
  const target = coordinator.service({ event: f.target, appKey: 'target', windowId: 'target', send () { assert.fail('expired delivery') }, guard () {} })
  target.ready()
  source.close(); target.close(); f.caller.close()
})

it('bounds invocations and refuses stale defaults without leaking handlers from other workspaces', async () => {
  const f = fixture()
  f.records.pop()
  f.coordinator.setDefault('profile', 'removed-handler')
  for (let i = 0; i < 8; i++) assert.equal((await f.invoke()).error, 'no handler')
  assert.equal((await f.invoke()).error, 'invoke rejected')
  assert.equal(f.discoveries.length, 8)
  f.caller.close()
})

it('uses an applicable remembered default and still requires consent for an explicit target', async () => {
  const f = fixture()
  const other = manifest(contract)
  f.records.push({ event: other, appId: nappletDescriptor(other).appId })
  f.coordinator.setDefault('profile', nappletDescriptor(f.target).catalogId)
  const target = f.endpoint(f.target, 'target'); target.ready()
  const result = await f.invoke()
  assert.equal(result.handler, nappletDescriptor(f.target).catalogId)
  await tick()
  assert.equal(f.deliveries.length, 1)
  f.caller.close(); target.close()
})
