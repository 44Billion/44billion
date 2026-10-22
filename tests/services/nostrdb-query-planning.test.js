import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { IDBFactory, IDBKeyRange, IDBIndex } from 'fake-indexeddb'
import { ParsedFilter, planQuery, tagValueIndexKey, toStoredRecord, INDEX } from '#services/idb/nostrdb/index.js'
import { selectTagQueryPlan } from '#services/idb/nostrdb/query-plan.js'

globalThis.IDBKeyRange = IDBKeyRange
const databases = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const done = tx => new Promise((resolve, reject) => {
  tx.addEventListener('complete', resolve)
  tx.addEventListener('abort', () => reject(tx.error))
})
async function fixture ({ count = 100, tags = i => [['k', '30078'], ['c', 'shared'], ['o', 'type'], ['o', `id-${i}`], ['v', '0']] } = {}) {
  const indexedDB = new IDBFactory()
  const open = indexedDB.open('planner', 1)
  open.onupgradeneeded = () => open.result.createObjectStore('events', { keyPath: 'i' }).createIndex(INDEX.tag, 't', { multiEntry: true })
  const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
  databases.push(db)
  const tx = db.transaction('events', 'readwrite')
  const completed = done(tx)
  for (let i = 0; i < count; i++) {
    tx.objectStore('events').put(toStoredRecord({ id: i.toString(16).padStart(64, '0'), kind: 1006, pubkey: 'a'.repeat(64), created_at: i, content: '', tags: tags(i) }))
  }
  await completed
  return db
}
const select = (db, filter, options) => selectTagQueryPlan(db, filter, planQuery(filter), { tagValueKey: tagValueIndexKey, ...options })
function observe (t) {
  const probes = []
  const original = IDBIndex.prototype.getAllKeys
  t.mock.method(IDBIndex.prototype, 'count', () => assert.fail('planning must never count entire ranges'))
  t.mock.method(IDBIndex.prototype, 'getAllKeys', function (range, limit) {
    probes.push({ tag: range.lower[0], value: range.lower[1], limit })
    return original.call(this, range, limit)
  })
  return probes
}

it('selects source identity rather than the shared personal-copy context', async () => {
  const db = await fixture()
  const filter = new ParsedFilter({ '#c': ['shared'], '#o': ['id-5'] })
  const plan = await select(db, filter)
  assert.equal(plan.cursors.length, 1)
  assert.deepEqual(plan.cursors[0].range.lower.slice(0, 2), ['o', tagValueIndexKey('id-5')])
})

it('selects one mandatory AND value, retaining every OR alternative', async () => {
  const db = await fixture()
  const filter = new ParsedFilter({ '#k': ['30078'], '#c': ['shared'], '&o': ['type', 'id-5'] })
  const plan = await select(db, filter)
  assert.equal(plan.cursors.length, 1)
  assert.equal(plan.cursors[0].range.lower[1], tagValueIndexKey('id-5'))
  const orFilter = new ParsedFilter({ '#k': ['30078'], '#o': ['id-5', 'id-8'] })
  const orPlan = await select(db, orFilter)
  assert.equal(orPlan.cursors.length, 2)
  assert.deepEqual(orPlan.cursors.map(cursor => cursor.range.lower[1]), ['id-5', 'id-8'].map(tagValueIndexKey))
})

it('falls back to the baseline when every candidate is broad and selects an absent mandatory value', async () => {
  const db = await fixture()
  const filter = new ParsedFilter({ '#k': ['30078'], '#c': ['shared'] })
  const plan = await select(db, filter)
  assert.equal(plan.cursors[0].range.lower[0], 'k')
  const absent = await select(db, new ParsedFilter({ '#k': ['30078'], '&o': ['type', 'missing'] }))
  assert.equal(absent.cursors[0].range.lower[1], tagValueIndexKey('missing'))
})

it('probes at most sixteen distinct intervals and does no partial probing above the budget', async t => {
  const db = await fixture()
  const probes = observe(t)
  for (const count of [16, 17]) {
    probes.length = 0
    const filter = new ParsedFilter({ '&o': Array.from({ length: count }, (_, i) => `id-${i}`) })
    const timings = []
    const plan = await select(db, filter, { onTiming: value => timings.push(value) })
    assert.equal(timings.at(-1).count, count === 16 ? 16 : 0)
    assert.equal(probes.length, count === 16 ? 16 : 0)
    // The baseline union is already small. Selecting it still preserves AND.
    assert.equal(plan.cursors.length, count)
  }
})

it('uses a supplied live write transaction and sees its uncommitted index changes', async () => {
  const db = await fixture()
  const tx = db.transaction('events', 'readwrite')
  const completed = done(tx)
  // Probing on another transaction would hang behind this writer.
  tx.objectStore('events').clear()
  const filter = new ParsedFilter({ '#k': ['30078'], '#c': ['shared'] })
  const plan = await select(db, filter, { tx })
  assert.equal(plan.cursors[0].range.lower[0], 'k')
  await completed
})

it('opens its readonly planning transaction through the supplied scheduler', async () => {
  const db = await fixture()
  let scheduled = 0
  const plan = await select(db, new ParsedFilter({ '#k': ['30078'], '#c': ['shared'] }), {
    scheduleRead: async operation => {
      scheduled++
      return operation()
    }
  })
  assert.equal(plan.cursors[0].range.lower[0], 'k')
  assert.equal(scheduled, 1)

  const tx = db.transaction('events', 'readonly')
  const completed = done(tx)
  await select(db, new ParsedFilter({ '#k': ['30078'], '#c': ['shared'] }), {
    tx,
    scheduleRead: () => assert.fail('supplied transactions must not reschedule')
  })
  await completed
  assert.equal(scheduled, 1)
})

it('leaves direct and sync plans unchanged and opens no planning transaction', async () => {
  const db = { transaction () { assert.fail('unexpected planning transaction') } }
  for (const raw of [{ ids: ['a'.repeat(64)] }, { authors: ['a'.repeat(64)], kinds: [0] }, { search: 'algo:sync' }, { kinds: [9] }, { '#k': ['9'] }]) {
    const filter = new ParsedFilter(raw)
    const baseline = planQuery(filter)
    assert.equal(await selectTagQueryPlan(db, filter, baseline, { tagValueKey: tagValueIndexKey }), baseline)
  }
})

for (const size of [0, 1, 64]) {
  it(`stops after a complete baseline of ${size} entries without probing broad alternatives`, async t => {
    const db = await fixture({ tags: i => [['k', i < size ? 'small' : 'other'], ['c', 'shared'], ['v', '0']] })
    const probes = observe(t)
    const timings = []
    const filter = new ParsedFilter({ '#k': ['small'], '#c': ['shared'], '#v': ['0', '1'] })
    const baseline = planQuery(filter)
    const plan = await selectTagQueryPlan(db, filter, baseline, { tagValueKey: tagValueIndexKey, onTiming: row => timings.push(row) })
    assert.equal(plan, baseline)
    assert.deepEqual(probes.map(probe => probe.tag), ['k'])
    assert.equal(probes[0].limit, 65)
    assert.equal(timings[0].keysExamined, size)
    assert.equal(timings[0].earlyDecision, true)
  })
}

it('treats 65 returned keys as incomplete and probes a selective alternative', async t => {
  const db = await fixture({ tags: i => [['k', i < 65 ? 'boundary' : 'other'], ['o', `id-${i}`]] })
  const probes = observe(t)
  const plan = await select(db, new ParsedFilter({ '#k': ['boundary'], '#o': ['id-3'] }))
  assert.deepEqual(probes.map(probe => probe.tag), ['k', 'o'])
  assert.equal(plan.cursors[0].range.lower[0], 'o')
})

it('does not mistake an empty first OR interval for an empty complete candidate', async t => {
  const db = await fixture()
  const probes = observe(t)
  const filter = new ParsedFilter({ '#k': ['30078'], '#o': ['missing', 'type'] })
  const baseline = planQuery(filter)
  const plan = await selectTagQueryPlan(db, filter, baseline, { tagValueKey: tagValueIndexKey })
  assert.equal(plan, baseline)
  assert.deepEqual(probes.map(probe => probe.tag), ['k', 'o', 'o'])
})

it('prefers a small mandatory AND candidate before a smaller personal-copy mirror', async t => {
  const db = await fixture({ tags: i => [['k', '30078'], ['x', i < 3 ? 'rare' : 'common'], ['o', `id-${i}`]] })
  const probes = observe(t)
  const plan = await select(db, new ParsedFilter({ kinds: [1006], '#k': ['30078'], '#o': ['id-1'], '&x': ['rare'] }))
  assert.deepEqual(probes.map(probe => probe.tag), ['k', 'x'])
  assert.equal(plan.cursors[0].range.lower[0], 'x')
})

it('prioritizes OR mirrors only for exclusively personal-copy queries', async t => {
  const db = await fixture()
  const probes = observe(t)
  for (const kinds of [[1006], [9], [1006, 9]]) {
    probes.length = 0
    await select(db, new ParsedFilter({ kinds, '#k': ['30078'], '#c': ['shared'], '#o': ['id-1'] }))
    assert.deepEqual(probes.map(probe => probe.tag), kinds.length === 1 && kinds[0] === 1006 ? ['k', 'o'] : ['k', 'c', 'o'])
  }
})

it('queues baseline and the preferred recovery mirror together without waiting for the first sample', async t => {
  const db = await fixture()
  const probes = []
  let callsAtFirstSuccess
  const original = IDBIndex.prototype.getAllKeys
  t.mock.method(IDBIndex.prototype, 'getAllKeys', function (range, limit) {
    const request = original.call(this, range, limit)
    probes.push({ tag: range.lower[0], limit })
    request.addEventListener('success', () => { callsAtFirstSuccess ??= probes.length })
    return request
  })
  const filter = new ParsedFilter({
    kinds: [1006],
    '#k': ['30078'],
    '#c': ['shared'],
    '#v': ['0', '1'],
    '&o': ['type']
  })
  const timings = []
  const pending = select(db, filter, { recoveryRead: true, onTiming: value => timings.push(value) })

  assert.equal(probes.length, 2)
  assert.deepEqual(probes.map(probe => probe.tag), ['k', 'o'])
  const plan = await pending
  assert.equal(callsAtFirstSuccess, 2)
  assert.equal(plan.cursors.length, 1)
  assert.equal(plan.cursors[0].range.lower[0], 'o')
  assert.equal(timings[0].recoveryPlan, true)
  assert.equal(timings[0].recoveryPath, 'o')
  assert.equal(timings[0].probes, 2)
})

it('chooses the smaller complete recovery path and never probes more than twice', async t => {
  const db = await fixture({
    tags: i => [
      ['k', i < 30 ? 'recovery' : 'other'],
      ['c', i < 10 ? 'small' : 'wide'],
      ['o', i < 5 ? 'preferred' : 'wide-o'],
      ['v', '0']
    ]
  })
  const probes = observe(t)
  const filter = new ParsedFilter({
    kinds: [1006],
    '#k': ['recovery'],
    '#c': ['small'],
    '#v': ['0', '1'],
    '&o': ['preferred']
  })
  const plan = await select(db, filter, { recoveryRead: true })

  assert.deepEqual(probes.map(probe => probe.tag), ['k', 'o'])
  assert.equal(plan.cursors[0].range.lower[0], 'o')
})

it('keeps a smaller complete baseline instead of a larger complete recovery mirror', async t => {
  const db = await fixture({
    tags: i => [
      ['k', i < 4 ? 'recovery' : 'other'],
      ['c', i < 20 ? 'small' : 'wide'],
      ['o', i < 12 ? 'preferred' : 'wide-o'],
      ['v', '0']
    ]
  })
  const probes = observe(t)
  const filter = new ParsedFilter({
    kinds: [1006],
    '#k': ['recovery'],
    '#c': ['small'],
    '#v': ['0', '1'],
    '&o': ['preferred']
  })
  const plan = await select(db, filter, { recoveryRead: true })

  assert.deepEqual(probes.map(probe => probe.tag), ['k', 'o'])
  assert.equal(plan.cursors[0].range.lower[0], 'k')
})

it('uses a complete baseline when the recovery mirror saturates the probe', async t => {
  const db = await fixture({
    tags: i => [
      ['k', i < 3 ? 'recovery' : 'other'],
      ['c', i < 3 ? 'small' : 'wide'],
      ['o', i < 65 ? 'preferred' : 'wide-o'],
      ['v', '0']
    ]
  })
  const probes = observe(t)
  const filter = new ParsedFilter({
    kinds: [1006],
    '#k': ['recovery'],
    '#c': ['small'],
    '#v': ['0', '1'],
    '&o': ['preferred']
  })
  const plan = await select(db, filter, { recoveryRead: true })

  assert.deepEqual(probes.map(probe => probe.tag), ['k', 'o'])
  assert.equal(plan.cursors[0].range.lower[0], 'k')
})

it('prefers the recovery mirror when complete baseline and mirror samples tie', async t => {
  const db = await fixture({
    tags: i => [
      ['k', i < 10 ? 'recovery' : 'other'],
      ['c', i < 10 ? 'small' : 'wide'],
      ['o', i < 10 ? 'preferred' : 'wide-o'],
      ['v', '0']
    ]
  })
  const probes = observe(t)
  const filter = new ParsedFilter({
    kinds: [1006],
    '#k': ['recovery'],
    '#c': ['small'],
    '#v': ['0', '1'],
    '&o': ['preferred']
  })
  const plan = await select(db, filter, { recoveryRead: true })

  assert.deepEqual(probes.map(probe => probe.tag), ['k', 'o'])
  assert.equal(plan.cursors[0].range.lower[0], 'o')
})

it('uses the full recovery OR plan without probes when the mirror has multiple values', async t => {
  const db = await fixture()
  const probes = observe(t)
  const filter = new ParsedFilter({
    kinds: [1006],
    '#o': ['id-1', 'id-2'],
    '#c': ['shared']
  })
  const plan = await select(db, filter, { recoveryRead: true })

  assert.deepEqual(probes, [])
  assert.equal(plan.cursors.length, 2)
  assert.equal(plan.cursors.every(cursor => cursor.range.lower[0] === 'o'), true)
})

it('uses baseline without probes when recovery has no mirror selector', async t => {
  const db = await fixture()
  const probes = observe(t)
  const filter = new ParsedFilter({
    kinds: [1006],
    '#k': ['30078'],
    '#c': ['shared']
  })
  const baseline = planQuery(filter)
  const plan = await select(db, filter, { recoveryRead: true })

  assert.deepEqual(probes, [])
  assert.deepEqual(plan.cursors.map(cursor => cursor.range.lower[0]), baseline.cursors.map(cursor => cursor.range.lower[0]))
})

it('rejects an already-aborted recovery planning signal without returning a plan', async () => {
  const db = await fixture()
  const filter = new ParsedFilter({ kinds: [1006], '#c': ['shared'], '&o': ['type'] })
  const controller = new AbortController()
  const reason = Object.assign(new Error('deferred'), { code: 'NOSTRDB_PLANNING_PREEMPTED' })
  controller.abort(reason)

  await assert.rejects(
    select(db, filter, { recoveryRead: true, signal: controller.signal }),
    error => error === reason
  )
})

it('propagates a recovery probe failure without selecting a path', async t => {
  const db = await fixture()
  const failure = new Error('recovery planning unavailable')
  t.mock.method(IDBIndex.prototype, 'getAllKeys', () => { throw failure })
  const filter = new ParsedFilter({ kinds: [1006], '#c': ['shared'], '&o': ['type'] })

  await assert.rejects(select(db, filter, { recoveryRead: true }), error => error === failure)
})

it('caps all returned keys at 256 and never interprets the truncated last sample as small', async t => {
  const db = await fixture({ tags: () => [['k', 'wide'], ['c', 'wide'], ['x', 'wide'], ['y', 'wide'], ['o', 'wide']] })
  const probes = observe(t)
  const timings = []
  const filter = new ParsedFilter({ kinds: [1006], '#k': ['wide'], '#c': ['wide'], '#x': ['wide'], '#y': ['wide'], '#o': ['wide'] })
  const baseline = planQuery(filter)
  const plan = await selectTagQueryPlan(db, filter, baseline, { tagValueKey: tagValueIndexKey, onTiming: row => timings.push(row) })
  assert.equal(plan, baseline)
  assert.deepEqual(probes.map(probe => probe.limit), [65, 65, 65, 61])
  assert.equal(timings[0].keysExamined, 256)
  assert.equal(timings[0].budgetExhausted, true)
  assert.equal(timings[0].earlyDecision, false)
})

it('shares samples only within one planning operation', async t => {
  const db = await fixture()
  const probes = observe(t)
  const filter = new ParsedFilter({ '#k': ['30078'], '#c': ['shared'] })
  for (let i = 0; i < 2; i++) {
    probes.length = 0
    await select(db, filter)
    assert.deepEqual(probes.map(probe => probe.tag), ['k', 'c'])
  }
})

it('propagates a failed probe and aborts only a transaction it created', async t => {
  const db = await fixture()
  const filter = new ParsedFilter({ '#k': ['30078'], '#c': ['shared'] })
  const failure = new Error('storage unavailable')
  t.mock.method(IDBIndex.prototype, 'getAllKeys', () => { throw failure })
  await assert.rejects(select(db, filter), error => error === failure)
  const tx = db.transaction('events', 'readwrite')
  const completed = done(tx)
  await assert.rejects(select(db, filter, { tx }), error => error === failure)
  tx.objectStore('events').clear()
  await completed
})
