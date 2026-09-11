import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'
import {
  NOSTRDB_MAINTENANCE_STORE as MAINTENANCE,
  NOSTRDB_UNCLAIMED_APP_DATA_KEY as CHECKPOINT
} from '#constants/storage-schema.js'
import {
  EVENTS_STORE,
  NOSTRDB_PREFIX,
  NOSTRDB_VERSION,
  NostrDb,
  openNostrDb,
  toStoredRecord
} from '#services/idb/nostrdb/index.js'

import { withQuotaMutation, putQuotaEvent } from '#services/idb/nostrdb/quotas.js'

globalThis.indexedDB = indexedDB
globalThis.IDBKeyRange = IDBKeyRange

const DAY = 24 * 60 * 60 * 1000
const NOW = 40 * DAY
const instances = []
const connections = []
let ownerCounter = 0

afterEach(() => {
  for (const db of instances.splice(0)) {
    db.stopMaintenance()
    db.bc?.close()
  }
  for (const db of connections.splice(0)) db.close()
})

function requestResult (request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function instance (owner) {
  const db = new NostrDb(owner)
  instances.push(db)
  return db
}

async function fixture (count) {
  const owner = (++ownerCounter).toString(16).padStart(64, '0')
  const db = instance(owner)
  const raw = await openNostrDb(owner)
  connections.push(raw)
  const rows = Array.from({ length: count }, (_, i) => toStoredRecord({
    id: (i + 1).toString(16).padStart(64, '0'),
    pubkey: 'a'.repeat(64),
    sig: '0'.repeat(128),
    kind: 78,
    created_at: 0,
    tags: [],
    content: ''
  }, { now: 0 })).sort((a, b) => indexedDB.cmp(a.i, b.i))
  return { owner, db, raw, rows }
}

async function writeRows (raw, rows) {
  await withQuotaMutation(raw, async tx => {
    for (const row of rows) await putQuotaEvent(raw, tx, row)
  })
}

async function readState (raw) {
  return requestResult(raw.transaction(MAINTENANCE).objectStore(MAINTENANCE).get(CHECKPOINT))
}

async function countRows (raw) {
  return requestResult(raw.transaction(EVENTS_STORE).objectStore(EVENTS_STORE).count())
}

function schedulerClock (t, start = NOW) {
  let now = start
  const timers = []
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, cancelled: false, unref () {} }
    timers.push(timer)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', timer => { timer.cancelled = true })
  return {
    timers,
    setNow (value) { now = value },
    async fire () {
      const timer = timers.shift()
      assert.ok(timer)
      if (!timer.cancelled) await timer.callback()
    }
  }
}

it('advances beyond 1,000 non-candidates and resumes after reopening the database', async () => {
  const { owner, db, raw, rows } = await fixture(1002)
  for (const row of rows.slice(0, 1000)) {
    row.k = row.event.kind = 1
  }
  await writeRows(raw, rows)
  assert.equal(await db.purgeUnclaimedAppData({ now: NOW / 1000 }), 0)
  assert.equal((await readState(raw)).after, rows[999].i)
  assert.equal(await countRows(raw), 1002)

  db.stopMaintenance()
  db.bc?.close()
  raw.onversionchange() // Close the connection and evict it from the module cache.
  const reopened = await openNostrDb(owner)
  connections.push(reopened)
  assert.notEqual(reopened, raw)
  assert.equal(await instance(owner).purgeUnclaimedAppData({ now: NOW / 1000 }), 2)
  assert.equal(await countRows(reopened), 1000)
  assert.deepEqual(await readState(reopened), { key: CHECKPOINT, after: null, completedAt: NOW })
})

it('keeps the default deletion page bounded to 100 candidates', async () => {
  const { db, raw, rows } = await fixture(105)
  await writeRows(raw, rows)
  assert.equal(await db.purgeUnclaimedAppData({ now: NOW / 1000 }), 100)
  assert.equal(await countRows(raw), 5)
  assert.equal((await readState(raw)).after, rows[99].i)
  assert.equal(await db.purgeUnclaimedAppData({ now: NOW / 1000 }), 5)
  assert.equal(await countRows(raw), 0)
  assert.equal((await readState(raw)).after, null)
})

it('revisits insertions before the checkpoint and newly eligible rows in the next sweep', async () => {
  const { db, raw, rows } = await fixture(3)
  rows[1].ra = NOW
  await writeRows(raw, rows.slice(1))
  assert.equal(await db.purgeUnclaimedAppData({ now: NOW / 1000, maxScanned: 1 }), 0)
  assert.equal((await readState(raw)).after, rows[1].i)
  await writeRows(raw, [rows[0]])
  assert.equal(await db.purgeUnclaimedAppData({ now: NOW / 1000 }), 1)
  assert.equal(await countRows(raw), 2)
  assert.equal((await readState(raw)).after, null)
  assert.equal(await db.purgeUnclaimedAppData({ now: (NOW + 31 * DAY) / 1000 }), 2)
  assert.equal(await countRows(raw), 0)
})

it('rolls back both deletion and checkpoint when interrupted before commit', async t => {
  const { db, raw, rows } = await fixture(3)
  await writeRows(raw, rows)
  assert.equal(await db.purgeUnclaimedAppData({ now: NOW / 1000, batchSize: 1 }), 1)
  const previous = await readState(raw)
  const original = raw.transaction.bind(raw)
  const mock = t.mock.method(raw, 'transaction', (stores, mode, ...args) => {
    const tx = original(stores, mode, ...args)
    if (mode === 'readwrite' && stores.includes(MAINTENANCE)) {
      const store = tx.objectStore(MAINTENANCE)
      const put = store.put.bind(store)
      store.put = (...args) => {
        const request = put(...args)
        request.addEventListener('success', () => tx.abort(), { once: true })
        return request
      }
    }
    return tx
  })
  assert.equal(await db.purgeUnclaimedAppData({ now: NOW / 1000 }), 0)
  assert.equal(await countRows(raw), 2)
  assert.deepEqual(await readState(raw), previous)
  mock.mock.restore()
  assert.equal(await db.purgeUnclaimedAppData({ now: NOW / 1000 }), 2)
  assert.equal(await countRows(raw), 0)
  assert.equal((await readState(raw)).after, null)
})

it('serializes concurrent page calls through the persisted checkpoint', async () => {
  const { db, raw, rows } = await fixture(4)
  await writeRows(raw, rows)
  assert.deepEqual(await Promise.all([
    db.purgeUnclaimedAppData({ now: NOW / 1000, batchSize: 2 }),
    db.purgeUnclaimedAppData({ now: NOW / 1000, batchSize: 2 })
  ]), [2, 2])
  assert.equal(await countRows(raw), 0)
  assert.equal((await readState(raw)).after, rows[3].i)
})

it('pauses between pages, resumes next visit and preserves the daily completion deadline', async t => {
  const { owner, db, raw, rows } = await fixture(3)
  rows[0].k = rows[0].event.kind = 1
  await writeRows(raw, rows)
  const clock = schedulerClock(t)
  const stop = db.startUnclaimedAppDataPurge({ maxScanned: 1 })
  assert.equal(clock.timers[0].delay, 1000)
  assert.equal(await readState(raw), undefined)
  await clock.fire()
  assert.equal((await readState(raw)).after, rows[0].i)
  assert.equal(clock.timers[0].delay, 1000)
  stop()
  await clock.fire() // The cancelled timer cannot advance the checkpoint.
  assert.equal((await readState(raw)).after, rows[0].i)

  clock.setNow(NOW + 10000)
  const stopResumed = instance(owner).startUnclaimedAppDataPurge()
  await clock.fire()
  assert.equal(await countRows(raw), 1)
  const completedAt = NOW + 10000
  assert.deepEqual(await readState(raw), { key: CHECKPOINT, after: null, completedAt })
  assert.equal(clock.timers[0].delay, DAY)
  stopResumed()
  await clock.fire()

  await writeRows(raw, [rows[1]])
  clock.setNow(completedAt + 3600000)
  const stopRevisited = instance(owner).startUnclaimedAppDataPurge()
  await clock.fire()
  assert.equal(await countRows(raw), 2)
  assert.equal((await readState(raw)).completedAt, completedAt)
  assert.equal(clock.timers[0].delay, DAY - 3600000)
  clock.setNow(completedAt + DAY)
  await clock.fire()
  assert.equal(await countRows(raw), 1)
  assert.equal((await readState(raw)).completedAt, completedAt + DAY)
  stopRevisited()
})

it('schedules the next page only after commit and does not restart after stopping in flight', async t => {
  const { db, raw, rows } = await fixture(3)
  await writeRows(raw, rows)
  const clock = schedulerClock(t)
  const stop = db.startUnclaimedAppDataPurge({ batchSize: 1 })
  const tick = clock.fire()
  assert.equal(clock.timers.length, 0)
  stop()
  await tick
  assert.equal(await countRows(raw), 2)
  assert.equal((await readState(raw)).after, rows[0].i)
  assert.equal(clock.timers.length, 0)
})

it('retries a failed scheduled page after one minute without marking the sweep complete', async t => {
  const { db, raw, rows } = await fixture(3)
  await writeRows(raw, rows)
  await db.purgeUnclaimedAppData({ now: NOW / 1000, batchSize: 1 })
  const previous = await readState(raw)
  const clock = schedulerClock(t)
  const transaction = raw.transaction.bind(raw)
  const mock = t.mock.method(raw, 'transaction', (stores, mode, ...args) => {
    if (mode === 'readwrite' && stores.includes(MAINTENANCE)) throw new Error('temporary write failure')
    return transaction(stores, mode, ...args)
  })
  const stop = db.startUnclaimedAppDataPurge()
  await clock.fire()
  assert.deepEqual(await readState(raw), previous)
  assert.equal(await countRows(raw), 2)
  assert.equal(clock.timers[0].delay, 60000)
  mock.mock.restore()
  clock.setNow(NOW + 60000)
  await clock.fire()
  assert.equal(await countRows(raw), 0)
  assert.deepEqual(await readState(raw), { key: CHECKPOINT, after: null, completedAt: NOW + 60000 })
  assert.equal(clock.timers[0].delay, DAY)
  stop()
})

it('upgrades an existing version 1 database without removing its records', async () => {
  const owner = (++ownerCounter).toString(16).padStart(64, '0')
  const request = indexedDB.open(`${NOSTRDB_PREFIX}${owner}`, 1)
  request.onupgradeneeded = () => {
    request.result.createObjectStore(EVENTS_STORE, { keyPath: 'i' }).put({ i: 'legacy-event' })
    request.result.createObjectStore('deletions', { keyPath: 'ref' }).put({ ref: 'legacy-tombstone' })
    request.result.createObjectStore('kindRegistry', { keyPath: 'key' })
  }
  const old = await requestResult(request)
  old.close()
  const upgraded = await openNostrDb(owner)
  connections.push(upgraded)
  assert.equal(upgraded.version, NOSTRDB_VERSION)
  assert.ok(upgraded.objectStoreNames.contains(MAINTENANCE))
  assert.equal(await countRows(upgraded), 1)
  assert.deepEqual(await requestResult(upgraded.transaction('deletions').objectStore('deletions').get('legacy-tombstone')), { ref: 'legacy-tombstone' })
  assert.equal(await readState(upgraded), undefined)
})
