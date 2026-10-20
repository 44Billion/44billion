import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { ParsedFilter, planQuery, tagValueIndexKey, toStoredRecord, INDEX } from '#services/idb/nostrdb/index.js'
import { selectTagQueryPlan } from '#services/idb/nostrdb/query-plan.js'

globalThis.IDBKeyRange = IDBKeyRange
const databases = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const done = tx => new Promise((resolve, reject) => {
  tx.addEventListener('complete', resolve)
  tx.addEventListener('abort', () => reject(tx.error))
})
async function fixture () {
  const indexedDB = new IDBFactory()
  const open = indexedDB.open('planner', 1)
  open.onupgradeneeded = () => open.result.createObjectStore('events', { keyPath: 'i' }).createIndex(INDEX.tag, 't', { multiEntry: true })
  const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
  databases.push(db)
  const tx = db.transaction('events', 'readwrite')
  const completed = done(tx)
  for (let i = 0; i < 100; i++) {
    tx.objectStore('events').put(toStoredRecord({ id: i.toString(16).padStart(64, '0'), kind: 1006, pubkey: 'a'.repeat(64), created_at: i, content: '', tags: [['k', '30078'], ['c', 'shared'], ['o', 'type'], ['o', `id-${i}`], ['v', '0']] }))
  }
  await completed
  return db
}
const select = (db, filter, options) => selectTagQueryPlan(db, filter, planQuery(filter), { tagValueKey: tagValueIndexKey, ...options })

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

it('preserves the baseline on equal estimates and selects an absent mandatory value', async () => {
  const db = await fixture()
  const filter = new ParsedFilter({ '#k': ['30078'], '#c': ['shared'] })
  const plan = await select(db, filter)
  assert.equal(plan.cursors[0].range.lower[0], 'k')
  const absent = await select(db, new ParsedFilter({ '#k': ['30078'], '&o': ['type', 'missing'] }))
  assert.equal(absent.cursors[0].range.lower[1], tagValueIndexKey('missing'))
})

it('counts at most sixteen distinct intervals and does no partial probing above the budget', async () => {
  const db = await fixture()
  for (const count of [16, 17]) {
    const filter = new ParsedFilter({ '&o': Array.from({ length: count }, (_, i) => `id-${i}`) })
    const timings = []
    const plan = await select(db, filter, { onTiming: value => timings.push(value) })
    assert.equal(timings.at(-1).count, count === 16 ? 16 : 0)
    assert.equal(plan.cursors.length, count === 16 ? 1 : 17)
  }
})

it('uses a supplied live write transaction and sees its uncommitted index changes', async () => {
  const db = await fixture()
  const tx = db.transaction('events', 'readwrite')
  const completed = done(tx)
  // A count on another connection/transaction would hang behind this writer.
  tx.objectStore('events').clear()
  const filter = new ParsedFilter({ '#k': ['30078'], '#c': ['shared'] })
  const plan = await select(db, filter, { tx })
  assert.equal(plan.cursors[0].range.lower[0], 'k')
  await completed
})

it('leaves direct and sync plans unchanged and opens no planning transaction', async () => {
  const db = { transaction () { assert.fail('unexpected planning transaction') } }
  for (const raw of [{ ids: ['a'.repeat(64)] }, { authors: ['a'.repeat(64)], kinds: [0] }, { search: 'algo:sync' }, { kinds: [9] }]) {
    const filter = new ParsedFilter(raw)
    const baseline = planQuery(filter)
    assert.equal(await selectTagQueryPlan(db, filter, baseline, { tagValueKey: tagValueIndexKey }), baseline)
  }
})
