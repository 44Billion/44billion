import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trackAccountEvents, shouldStoreAccountEvent } from '../../src/services/account-events.js'
import { withInitialResults } from '../../src/services/idb/nostrdb/initial-subscription.js'

const pubkey = 'a'.repeat(64)
const event = (kind, createdAt = 10, tags = []) => ({ id: String(createdAt).padStart(64, '0'), pubkey, kind, created_at: createdAt, tags, content: '' })

test('account import excludes both NIP-78 kinds and range/tag-defined ephemeral events', () => {
  for (const kind of [78, 30078, 20000, 22242, 29999]) assert.equal(shouldStoreAccountEvent(event(kind)), false)
  assert.equal(shouldStoreAccountEvent(event(1, 10, [['expiration', '10']])), false)
  for (const kind of [0, 1, 3, 9, 10002, 10003, 30023, 40000]) assert.equal(shouldStoreAccountEvent(event(kind)), true)
})

test('account tracking starts without a relay list, imports all kinds, discovers updated write relays and forwards only metadata to vault', async () => {
  const controller = new AbortController()
  const calls = []
  const stored = []
  const vault = []
  const failures = []
  const feeds = new Map([
    ['wss://seed.example', [event(1), event(0), event(78), event(30078), event(22242), event(10002, 20, [['r', 'wss://first.example', 'write']]), event(10002, 30, [['r', 'wss://next.example'], ['r', 'wss://read.example', 'read']])]],
    ['wss://first.example', [event(3), event(0, 9)]],
    ['wss://next.example', [event(30023), event(0, 40)]]
  ])
  trackAccountEvents({
    pubkey, signal: controller.signal, seeds: ['wss://seed.example'], getStoredEvent: () => null,
    pool: { async * getEventsFeedGenerator (filter, relays, options) { calls.push({ filter, relays, options }); yield * feeds.get(relays[0]) } },
    db: { async add (event) { stored.push(event); if (event.kind === 1) throw new Error('Storage failure'); return { ok: true } } },
    sendToVault: event => vault.push(event), reportError: error => failures.push(error)
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls.length, 3)
  for (const call of calls) { assert.deepEqual(call.filter, { authors: [pubkey] }); assert.equal(call.options.signal, controller.signal) }
  assert.ok(stored.some(event => event.kind === 3))
  assert.ok(stored.some(event => event.kind === 30023))
  assert.ok(stored.every(shouldStoreAccountEvent))
  assert.ok(vault.every(event => event.kind === 0 || event.kind === 10002))
  assert.equal(vault.filter(event => event.kind === 0).length, 2)
  assert.equal(failures.length, 1)
  controller.abort()
})

test('initial subscription preserves live arrivals during the snapshot and closes pending work', async () => {
  let finish
  let closed = false
  const live = { next: async () => ({ done: false, value: { result: 'live' } }), return: async () => { closed = true } }
  const stream = withInitialResults(live, () => new Promise(resolve => { finish = resolve }))
  const first = stream.next()
  finish({ results: ['stored'] })
  assert.deepEqual(await first, { done: false, value: { result: 'stored' } })
  assert.deepEqual(await stream.next(), { done: false, value: { result: 'live' } })
  await stream.return()
  assert.equal(closed, true)
  const waiting = withInitialResults(live, () => new Promise(resolve => { finish = resolve }))
  const next = waiting.next()
  await waiting.return()
  finish({ results: ['late'] })
  assert.deepEqual(await next, { done: true })
})

test('cached vault metadata seeds the event store even before relay delivery', async () => {
  const cached = [event(0), event(10002)]
  const stored = []
  const controller = new AbortController()
  trackAccountEvents({
    pubkey, signal: controller.signal, seeds: [], pool: {},
    getStoredEvent: kind => cached.find(event => event.kind === kind),
    db: { async add (event) { stored.push(event); return { ok: true } } },
    sendToVault: () => assert.fail('Cached metadata must not echo back to the vault')
  })
  assert.deepEqual(stored, cached)
  controller.abort()
})
