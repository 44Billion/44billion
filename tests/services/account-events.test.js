import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trackAccountEvents, shouldStoreAccountEvent } from '../../src/services/account-events.js'
import { withInitialResults } from '../../src/services/idb/nostrdb/initial-subscription.js'

const pubkey = 'a'.repeat(64)
const event = (kind, createdAt = 10, tags = []) => ({ id: String(createdAt).padStart(64, '0'), pubkey, kind, created_at: createdAt, tags, content: '' })
const tick = () => new Promise(resolve => setImmediate(resolve))

function trackerFixture (t, { cached, add } = {}) {
  const controller = new AbortController()
  t.after(() => controller.abort())
  const calls = []
  const stored = []
  const errors = []
  const seed = 'wss://seed.example'
  const pool = {
    getEventsFeedGenerator (filter, relays, { signal }) {
      const queue = []
      let wake = Promise.withResolvers()
      const call = { filter, relay: relays[0], stopped: false, closed: false }
      const stream = (async function * () {
        try {
          while (!signal.aborted && (!call.stopped || queue.length)) {
            if (queue.length) yield queue.shift()
            else { await wake.promise; wake = Promise.withResolvers() }
          }
        } finally {
          call.closed = true
          signal.removeEventListener('abort', abort)
        }
      })()
      const abort = () => wake.resolve()
      signal.addEventListener('abort', abort, { once: true })
      call.push = event => { if (!call.stopped) { queue.push(event); wake.resolve() } }
      stream.stopAndDrain = () => { call.stopped = true; wake.resolve() }
      call.end = stream.stopAndDrain
      calls.push(call)
      return stream
    }
  }
  trackAccountEvents({
    pubkey, signal: controller.signal, pool, seeds: [seed],
    getStoredEvent: kind => cached?.kind === kind ? cached : null,
    db: { async add (event) { stored.push(event); await add?.(event); return { ok: true } } },
    sendToVault: () => {}, reportError: error => errors.push(error)
  })
  t.after(() => assert.deepEqual(errors, []))
  return { calls, stored, seed, controller }
}

test('seed discovery survives write removal; accepted events drain even after the same relay is re-added', async t => {
  const pending = Promise.withResolvers()
  t.after(() => pending.resolve())
  const blocked = event(1, 11)
  const queued = event(3, 12)
  const fixture = trackerFixture(t, {
    cached: event(10002, 10, [['r', 'wss://seed.example'], ['r', 'wss://read.example', 'read']]),
    add: event => event === blocked ? pending.promise : undefined
  })
  const { calls, stored, seed } = fixture
  assert.equal(calls.length, 2)
  const [discovery, firstWrite] = calls
  assert.deepEqual(discovery.filter, { authors: [pubkey], kinds: [10002] })
  assert.deepEqual(firstWrite.filter, { authors: [pubkey] })
  firstWrite.push(blocked)
  firstWrite.push(queued)
  await tick()
  discovery.push(event(10002, 20, [['r', seed, 'read']]))
  await tick()
  assert.equal(firstWrite.stopped, true)
  assert.equal(discovery.stopped, false)
  assert.ok(!stored.includes(queued))

  discovery.push(event(10002, 30, [['r', seed, 'write']]))
  await tick()
  assert.equal(calls.length, 3)
  const secondWrite = calls[2]
  assert.equal(secondWrite.stopped, false)
  const late = event(1, 31)
  firstWrite.push(late)
  pending.resolve()
  await tick()
  assert.ok(stored.includes(queued), 'accepted event survives relay removal')
  assert.ok(!stored.includes(late), 'old signature does not reopen on re-addition')
  assert.equal(firstWrite.closed, true)
  assert.equal(secondWrite.closed, false)

  const unsolicited = event(1, 32)
  discovery.push(unsolicited)
  discovery.push(event(10002, 40, []))
  await tick()
  assert.ok(!stored.includes(unsolicited), 'seeds ingest only relay lists')
  assert.equal(secondWrite.stopped, true)
  assert.equal(discovery.stopped, false)
})

test('new relay lists reconcile write feeds, retaining unchanged relays and ignoring stale versions', async t => {
  const { calls, seed } = trackerFixture(t)
  assert.equal(calls.length, 1, 'without a known list only discovery runs')
  const discovery = calls[0]
  const initial = event(10002, 20, [['r', seed, 'write'], ['r', seed], ['r', 'wss://first.example']])
  discovery.push(initial)
  await tick()
  assert.equal(calls.length, 3, 'duplicate write URLs share one ingestion feed')
  const seedWrite = calls[1]
  const first = calls[2]
  first.push(event(10002, 30, [['r', seed], ['r', 'wss://next.example', 'write']]))
  await tick()
  assert.equal(calls.length, 4)
  assert.equal(first.stopped, true)
  assert.equal(seedWrite.stopped, false)
  discovery.push(initial)
  discovery.push({ ...event(10002, 30, []), id: 'f'.repeat(64) })
  await tick()
  assert.equal(calls.length, 4)
  assert.equal(calls[3].stopped, false)
  discovery.push({ ...event(10002, 30, []), id: '0'.repeat(64) })
  await tick()
  assert.equal(calls[3].stopped, true, 'lower ID wins a timestamp tie')
  assert.equal(seedWrite.stopped, true)
})

test('account cancellation discards pending ingestion even during a write drain', async t => {
  const pending = Promise.withResolvers()
  t.after(() => pending.resolve())
  const blocked = event(1, 11)
  const queued = event(3, 12)
  const { calls, controller, stored } = trackerFixture(t, {
    cached: event(10002, 10, [['r', 'wss://seed.example']]),
    add: event => event === blocked ? pending.promise : undefined
  })
  calls[1].push(blocked)
  calls[1].push(queued)
  await tick()
  calls[0].push(event(10002, 20, []))
  await tick()
  assert.equal(calls[1].stopped, true)
  controller.abort()
  pending.resolve()
  await tick()
  assert.ok(!stored.includes(queued))
  assert.ok(calls.every(call => call.closed))
})

test('removing a write relay cancels a pending retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { calls } = trackerFixture(t, {
    cached: event(10002, 10, [['r', 'wss://write.example']])
  })
  calls[1].end()
  await tick()
  calls[0].push(event(10002, 20, []))
  await tick()
  t.mock.timers.tick(30000)
  await tick()
  assert.equal(calls.length, 2, 'the removed feed must not restart')
  assert.equal(calls[0].closed, false)
})

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
    ['wss://first.example', [event(1), event(3), event(0, 9)]],
    ['wss://next.example', [event(30023), event(0, 40)]]
  ])
  trackAccountEvents({
    pubkey, signal: controller.signal, seeds: ['wss://seed.example'], getStoredEvent: () => null,
    pool: {
      getEventsFeedGenerator (filter, relays, options) {
        calls.push({ filter, relays, options })
        // This snapshot represents events already accepted by the transport.
        const stream = (async function * () { yield * feeds.get(relays[0]) })()
        stream.stopAndDrain = () => {}
        return stream
      }
    },
    db: { async add (event) { stored.push(event); if (event.kind === 1) throw new Error('Storage failure'); return { ok: true } } },
    sendToVault: event => vault.push(event), reportError: error => failures.push(error)
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls.length, 3)
  for (const call of calls) {
    assert.deepEqual(call.filter, { authors: [pubkey], ...(call.relays[0] === 'wss://seed.example' ? { kinds: [10002] } : {}) })
    assert.equal(call.options.signal, controller.signal)
  }
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
