import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAccountEventTracker, accountKinds, shouldStoreAccountEvent } from '../../src/services/account-events.js'
import { accountEventPages } from '../../src/services/account-event-pages.js'
import { withInitialResults } from '../../src/services/idb/nostrdb/initial-subscription.js'
import { accountRelayFixture } from '../fixtures/account-relay.js'
import { coverageFixture } from '../fixtures/account-coverage.js'

const NOW = Math.floor(Date.now() / 1000)
const relay = 'wss://relay.example'
const pk = i => i.toString(16).padStart(64, '0')
let serial = 0
const event = (kind = 1, createdAt = Math.floor(Date.now() / 1000) + 5, pubkey = pk(1), tags = []) => ({ id: (++serial).toString(16).padStart(64, '0'), pubkey, kind, created_at: createdAt, tags, content: '' })
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until (predicate) {
  const deadline = Date.now() + 5000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Condition timed out')
    await tick()
  }
}
async function fixture (t, { count = 1, events = [], beforeRead, add, readOnly = [], errorsAllowed = false } = {}) {
  const transport = accountRelayFixture({ events, beforeRead })
  const controller = new AbortController()
  const errors = []
  const vault = []
  const stored = []
  const tracker = createAccountEventTracker({ pool: transport.pool, seeds: [relay], signal: controller.signal, random: () => 0, reportError: (error, context) => errors.push({ error, context }) })
  t.after(async () => {
    controller.abort()
    await tracker.settled()
    await transport.pool.disconnectAll()
    if (!errorsAllowed) assert.deepEqual(errors, [])
  })
  const configs = []
  for (let i = 1; i <= count; i++) {
    const { coverage } = await coverageFixture(t)
    const pubkey = pk(i)
    configs.push({
      pubkey, coverage, isReadOnly: readOnly.includes(i),
      getStoredEvent: kind => kind === 10002 ? event(kind, 1, pubkey, [['r', relay]]) : null,
      db: { async add (value) { const result = await add?.(value); if (result?.ok === false) return result; stored.push({ owner: pubkey, event: value }); return { ok: true } } },
      sendToVault: value => vault.push(value)
    })
  }
  return {
    ...transport, controller, tracker, configs, stored, errors, vault,
    start: () => tracker.setAccounts(configs),
    covered: async (kind = 1) => (await configs[0].coverage.read(relay, [kind]))[0].intervals.some(([start, end]) => start === 0 && end >= NOW - 1)
  }
}

test('readonly metadata uses separate feeds without persistence or coverage', async t => {
  const events = Array.from({ length: 6 }, (_, i) => event(1, NOW - 1000, pk(i + 1)))
  const f = await fixture(t, { count: 6, events, readOnly: [6] })
  f.configs[5].coverage = new Proxy({}, { get () { throw new Error('Readonly coverage must not be touched') } })
  f.configs[5].db = { add () { throw new Error('Readonly storage must not be touched') } }
  f.start()
  await until(() => f.stored.filter(item => item.event.kind === 1).length === 5)
  await until(() => f.covered())
  const live = f.subscriptions.filter(sub => !sub.closed && sub.filter.limit === 0)
  assert.equal(live.length, 6)
  assert.ok(live.every(sub => sub.filter.kinds.length <= 30))
  assert.ok(live.filter(sub => sub.filter.authors.includes(pk(6))).every(sub => sub.filter.kinds.every(kind => [0, 10002].includes(kind))))
  assert.ok(f.stored.every(item => item.owner === item.event.pubkey))
  assert.ok(!f.stored.some(item => item.owner === pk(6)))
  assert.ok(!f.calls.some(call => call.filter.authors.includes(pk(6)) && call.filter.kinds.some(kind => ![0, 10002].includes(kind))))
  assert.ok(f.calls.every(call => call.filter.limit === 200 && call.filter.until !== undefined))
})

test('reload repeats only recent overlap once old history has been confirmed', async t => {
  const f = await fixture(t)
  for (const config of f.configs) {
    await config.coverage.reconcile(accountKinds)
    const rows = await config.coverage.read(relay, accountKinds)
    await config.coverage.mark(rows, 0, NOW - 20)
  }
  f.start()
  await until(() => f.covered())
  assert.ok(f.calls.every(call => call.filter.since >= NOW - 620), 'completed old history must not be fetched again')
  assert.ok(f.calls.some(call => call.filter.since <= NOW - 600), 'ten minute clock-skew overlap')
})

test('initial persistence failure discards pending live and does not advance that page', async t => {
  const failed = event(1, NOW - 10)
  const f = await fixture(t, { events: [failed], errorsAllowed: true, add: value => value.id === failed.id ? { ok: false, code: 'quota' } : undefined })
  f.start()
  await until(() => f.errors.length > 0)
  const rows = await f.configs[0].coverage.read(relay, [1])
  assert.deepEqual(rows[0].intervals, [])
  assert.equal(f.errors[0].context.relay, relay)
  assert.equal(f.errors[0].context.phase, 'initial-or-live')
  assert.ok(f.subscriptions.filter(sub => sub.filter.kinds.includes(1)).every(sub => sub.closed))
})

test('history timeout is not empty coverage and permanent refusal is not retried', async t => {
  const f = await fixture(t, { errorsAllowed: true, beforeRead: () => { throw new Error('restricted: denied') } })
  f.start()
  await until(() => f.errors.length === 4)
  assert.deepEqual((await f.configs[0].coverage.read(relay, [1]))[0].intervals, [])
  assert.ok(f.subscriptions.every(sub => sub.closed))
  await new Promise(resolve => setTimeout(resolve, 850))
  assert.equal(f.calls.length, 4)
})

test('retiring a relay drains accepted events, account removal discards its pending delivery', async t => {
  const pending = Promise.withResolvers()
  const blocked = event(1)
  const queued = event(3)
  const f = await fixture(t, { add: value => value.id === blocked.id ? pending.promise : undefined })
  t.after(() => pending.resolve())
  f.start()
  await until(() => f.covered())
  f.emit(blocked)
  f.emit(queued)
  await tick()
  f.emit(event(10002, Math.floor(Date.now() / 1000) + 10, pk(1), []))
  await until(() => f.subscriptions.filter(sub => sub.filter.kinds.includes(1)).every(sub => sub.closed))
  pending.resolve()
  await until(() => f.stored.some(item => item.event.id === queued.id))
  assert.equal(f.subscriptions.filter(sub => !sub.closed).length, 1, 'seed discovery remains')
  f.tracker.setAccounts([])
  await until(() => f.subscriptions.every(sub => sub.closed))
})

test('membership changes regroup feeds without closing unchanged relay groups', async t => {
  const f = await fixture(t, { count: 2 })
  f.start()
  await until(() => f.covered())
  const previous = f.subscriptions.filter(sub => !sub.closed)
  f.tracker.setAccounts([f.configs[0]])
  await until(() => previous.every(sub => sub.closed))
  await until(() => f.subscriptions.filter(sub => !sub.closed).length === 4)
  assert.ok(f.subscriptions.filter(sub => !sub.closed).every(sub => sub.filter.authors.length === 1))
  const profiles = [event(0, Math.floor(Date.now() / 1000) + 10), event(0, Math.floor(Date.now() / 1000) + 9)]
  profiles.forEach(f.emit)
  await until(() => f.vault.some(value => value.id === profiles[0].id))
  assert.ok(!f.vault.some(value => value.id === profiles[1].id))
})

test('backfill failure leaves initialized live running and confirmed recent coverage intact', async t => {
  const f = await fixture(t, { errorsAllowed: true, beforeRead: filter => { if (filter.since === 0) throw new Error('offline') } })
  f.start()
  await until(() => f.errors.some(item => item.context.phase === 'backfill'))
  assert.equal(f.subscriptions.filter(sub => !sub.closed && sub.filter.limit === 0).length, 4)
  const incoming = event(1, Math.floor(Date.now() / 1000) + 1)
  f.emit(incoming)
  await until(() => f.stored.some(item => item.event.id === incoming.id))
  assert.ok((await f.configs[0].coverage.read(relay, [1]))[0].intervals.some(([since]) => since >= NOW - 600))
})

test('live catches clock-skew arrivals without periodic historical refresh', async t => {
  const f = await fixture(t, {})
  f.start()
  await until(() => f.covered())
  const incoming = event(1, NOW - 300)
  const reads = f.calls.length
  f.emit(incoming) // matches the overlapping live filter
  await until(() => f.stored.some(item => item.event.id === incoming.id))
  assert.equal(f.subscriptions.filter(sub => sub.filter.limit === 0).length, 4)
  assert.equal(f.calls.length, reads)
})

test('transient initial read failure retries without duplicated stored messages', async t => {
  let failed = false
  const value = event(1, NOW - 10)
  const f = await fixture(t, {
    events: [value], errorsAllowed: true, beforeRead: filter => {
      if (!failed && filter.kinds.includes(1)) { failed = true; throw new Error('temporary disconnection') }
    }
  })
  f.start()
  await until(() => f.errors.length === 1)
  await until(() => f.covered())
  assert.equal(f.stored.filter(item => item.event.id === value.id).length, 1)
  assert.equal(f.subscriptions.filter(sub => !sub.closed && sub.filter.limit === 0).length, 4)
})

test('removing an account discards its queued deliveries while a stored write finishes', async t => {
  const pending = Promise.withResolvers()
  const blocked = event(1)
  const queued = event(3)
  const f = await fixture(t, { add: value => value.id === blocked.id ? pending.promise : undefined })
  f.start()
  await until(() => f.covered())
  f.emit(blocked)
  f.emit(queued)
  await tick()
  f.tracker.setAccounts([])
  pending.resolve()
  await f.tracker.settled()
  assert.ok(!f.stored.some(item => item.event.id === queued.id))
  assert.ok(f.subscriptions.every(sub => sub.closed))
})

test('account import excludes private/app/file flows and ephemeral events', () => {
  for (const kind of [4, 13, 14, 78, 1006, 1059, 3560, 10000, 10003, 30003, 30007, 30024, 30078, 30403, 34601, 20000, 22242, 29999, 40000]) assert.equal(shouldStoreAccountEvent(event(kind)), false)
  assert.equal(shouldStoreAccountEvent(event(1, 10, pk(1), [['expiration', '10']])), false)
  for (const kind of [0, 1, 3, 5, 9, 10002, 1063, 30000, 30023]) assert.equal(shouldStoreAccountEvent(event(kind)), true)
})

test('pages split saturated seconds by author and kind, accepting only the indivisible excess with warning', async () => {
  const events = []
  for (let i = 0; i < 240; i++) events.push(event(1, 100, pk(1)))
  for (let i = 0; i < 140; i++) events.push(event(3, 100, pk(1)), event(1, 100, pk(2)))
  const transport = accountRelayFixture({ events })
  const stored = new Set()
  const completed = []
  const warnings = []
  for await (const filter of accountEventPages({ pool: transport.pool, relay, filter: { authors: [pk(1), pk(2)], kinds: [1, 3], since: 0, until: 101 }, signal: new AbortController().signal, persist: async event => stored.add(event.id), warn: (...args) => warnings.push(args) })) completed.push(filter)
  assert.equal(stored.size, 480)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0][1].since, 100)
  assert.ok(completed.some(filter => filter.authors.length === 1 && filter.kinds.length === 1 && filter.since === 100))
  assert.ok(transport.calls.every(call => call.filter.limit === 200))
  await transport.pool.disconnectAll()
})

test('initial subscription preserves live arrivals during the snapshot and closes pending work', async () => {
  let finish
  let closed = false
  const live = { next: async () => ({ done: false, value: { type: 'id', id: 'live' } }), return: async () => { closed = true } }
  const stream = withInitialResults(live, () => new Promise(resolve => { finish = resolve }))
  const first = stream.next()
  await Promise.resolve()
  finish({ results: ['stored'] })
  assert.deepEqual(await first, { done: false, value: { type: 'id', id: 'stored', meta: { algorithm: undefined, sort: undefined, score: undefined } } })
  assert.deepEqual((await stream.next()).value, { type: 'eose' })
  assert.deepEqual(await stream.next(), { done: false, value: { type: 'id', id: 'live' } })
  await stream.return()
  assert.equal(closed, true)
  const waiting = withInitialResults(live, () => new Promise(resolve => { finish = resolve }))
  const next = waiting.next()
  await waiting.return()
  finish({ results: ['late'] })
  assert.deepEqual(await next, { done: true })
})

async function progressFixture (t, { add = async () => ({ ok: true }) } = {}) {
  const { coverage } = await coverageFixture(t)
  const queue = []
  let waiting
  let closed = false
  const stream = {
    push (value) { if (waiting) { const resolve = waiting; waiting = null; resolve({ value, done: false }) } else queue.push(value) },
    next () { return closed ? Promise.resolve({ done: true }) : queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : new Promise(resolve => { waiting = resolve }) },
    return () { closed = true; queue.length = 0; waiting?.({ done: true }); return Promise.resolve({ done: true }) },
    stopAndDrain () { return this.return() }
  }
  const report = { type: 'eose', relays: [{ relay, status: 'eose' }], snapshot: { since: NOW - 600, until: NOW } }
  const controller = new AbortController()
  const errors = []
  let reads = 0
  const pool = {
    getEventsFeedGenerator () { reads++; stream.push(report); return stream },
    async * getEventsGenerator () { reads++; yield report }
  }
  const tracker = createAccountEventTracker({ pool, seeds: [relay], signal: controller.signal, now: () => NOW, reportError: error => errors.push(error) })
  tracker.setAccounts([{ pubkey: pk(1), coverage, db: { add }, getStoredEvent: () => null, sendToVault: () => {} }])
  t.after(async () => { controller.abort(); await tracker.settled() })
  const rows = () => coverage.read(relay, [10002])
  await until(async () => (await rows())[0].intervals[0]?.[0] === 0)
  return { stream, rows, errors, reads: () => reads, controller, tracker }
}
const progress = (since = NOW, until = NOW + 60, epoch = 1) => ({ type: 'live-progress', relay, epoch, since, until })

test('live progress advances empty intervals without history reads and ignores unknown controls', async t => {
  const f = await progressFixture(t)
  const reads = f.reads()
  f.stream.push({ type: 'future-control', event: event() })
  f.stream.push(progress())
  await until(async () => (await f.rows())[0].intervals.at(-1)[1] === NOW + 60)
  f.stream.push(progress(NOW + 120, NOW + 180))
  await until(async () => (await f.rows())[0].intervals.length === 2)
  assert.deepEqual((await f.rows())[0].intervals, [[0, NOW + 60], [NOW + 120, NOW + 180]])
  assert.equal(f.reads(), reads)
  assert.deepEqual(f.errors, [])
})

test('live checkpoint waits for preceding storage and is discarded on storage failure', async t => {
  const pending = Promise.withResolvers()
  let writing = false
  const f = await progressFixture(t, { add: async () => { writing = true; return pending.promise } })
  f.stream.push({ type: 'event', event: event(10002, NOW + 5) })
  f.stream.push(progress())
  await until(() => writing)
  assert.equal((await f.rows())[0].intervals.at(-1)[1], NOW)
  pending.resolve({ ok: false, code: 'quota' })
  await until(() => f.errors.length === 1)
  assert.equal((await f.rows())[0].intervals.at(-1)[1], NOW)
  assert.equal(f.errors[0].code, 'quota')
})

test('live checkpoint commits after a slow successful write and rejects changed epochs', async t => {
  const pending = Promise.withResolvers()
  let writing = false
  const f = await progressFixture(t, { add: async () => { writing = true; return pending.promise } })
  f.stream.push({ type: 'event', event: event(10002, NOW + 5) })
  f.stream.push(progress())
  await until(() => writing)
  assert.equal((await f.rows())[0].intervals.at(-1)[1], NOW)
  pending.resolve({ ok: true })
  await until(async () => (await f.rows())[0].intervals.at(-1)[1] === NOW + 60)
  f.stream.push(progress(NOW, NOW + 120, 2))
  await until(() => f.errors.length === 1)
  assert.equal((await f.rows())[0].intervals.at(-1)[1], NOW + 60)
})

test('read-only profiles use unrestricted snapshots and state changes retire full ingestion', async t => {
  const profile = event(0, 100)
  const f = await fixture(t, { events: [profile] })
  f.start()
  await until(() => f.covered())
  const previous = f.subscriptions.filter(sub => !sub.closed)
  const stored = f.stored.length
  f.tracker.setAccounts([{ ...f.configs[0], isReadOnly: true }])
  await until(() => previous.every(sub => sub.closed))
  await until(() => f.calls.some(call => call.filter.kinds.includes(0) && call.filter.since === 0))
  await until(() => f.subscriptions.filter(sub => !sub.closed).length === 2)
  assert.equal(f.stored.length, stored)
  assert.ok(f.vault.some(value => value.id === profile.id))
  assert.ok(f.subscriptions.filter(sub => !sub.closed).every(sub => sub.filter.kinds.every(kind => [0, 10002].includes(kind))))
})
