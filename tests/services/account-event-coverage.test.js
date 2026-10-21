import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDBObjectStore } from 'fake-indexeddb'
import { mergeCoverage, missingCoverage } from '../../src/services/account-event-coverage.js'
import {
  NOSTRDB_ACCOUNT_COVERAGE_PREFIX,
  NOSTRDB_ACCOUNT_COVERAGE_REGISTRY
} from '../../src/constants/storage-schema.js'

import { coverageFixture } from '../fixtures/account-coverage.js'

const relay = 'wss://relay.example'
const kinds = Array.from({ length: 30 }, (_, index) => index + 1)
const coverageKey = key => typeof key === 'string' && key.startsWith(NOSTRDB_ACCOUNT_COVERAGE_PREFIX) && key !== NOSTRDB_ACCOUNT_COVERAGE_REGISTRY

test('merges adjacent inclusive ranges and enumerates only missing windows newest first', () => {
  assert.deepEqual(mergeCoverage([[9, 10], [1, 3], [4, 8], [20, 30]]), [[1, 10], [20, 30]])
  assert.deepEqual(missingCoverage([[1, 10], [20, 30]], 0, 40), [[31, 40], [11, 19], [0, 0]])
})

test('coverage is relay/kind scoped, survives a new reader and merges concurrent checkpoints', async t => {
  const { coverage, make } = await coverageFixture(t)
  await coverage.reconcile([0, 1, 3])
  const rows = await coverage.read(relay, [0, 1])
  const other = make()
  await other.reconcile([0, 1, 3])
  const same = await other.read(relay + '/', [0, 1])
  await Promise.all([coverage.mark(rows, 0, 100), other.mark(same, 101, 200)])
  assert.deepEqual((await other.read(relay, [0, 1])).map(row => row.intervals), [[[0, 200]], [[0, 200]]])
  assert.deepEqual((await other.read('wss://new.example', [0]))[0].intervals, [])
  assert.deepEqual((await other.read(relay, [3]))[0].intervals, [])
})

test('startup removes retired kinds, preserves unchanged coverage and adds empty new kinds', async t => {
  const { coverage, make } = await coverageFixture(t)
  await coverage.reconcile([0, 1])
  const rows = await coverage.read(relay, [0, 1])
  await coverage.mark(rows, 0, 100)
  const next = make()
  await next.reconcile([1, 3])
  assert.deepEqual((await next.read(relay, [1, 3])).map(row => row.intervals), [[[0, 100]], []])
  await assert.rejects(coverage.mark(rows, 101, 200), { code: 'ACCOUNT_COVERAGE_RESET' })
})

test('reset between events and checkpoint fences old work and malformed ranges reset safely', async t => {
  const { coverage, db } = await coverageFixture(t)
  await coverage.reconcile([1])
  const rows = await coverage.read(relay, [1])
  await new Promise(resolve => { const tx = db.transaction('maintenance', 'readwrite'); tx.objectStore('maintenance').clear(); tx.oncomplete = resolve })
  await assert.rejects(coverage.mark(rows, 0, 100), { code: 'ACCOUNT_COVERAGE_RESET' })
  const current = await coverage.read(relay, [1])
  assert.notEqual(current[0].generation, rows[0].generation)
  await new Promise(resolve => {
    const tx = db.transaction('maintenance', 'readwrite')
    tx.objectStore('maintenance').put({ ...current[0], intervals: [[100, 0]] })
    tx.objectStore('maintenance').put({ key: 'unrelated', value: 42 })
    tx.oncomplete = resolve
  })
  await coverage.reconcile([1])
  assert.deepEqual((await coverage.read(relay, [1]))[0].intervals, [])
  const unknown = await new Promise(resolve => { db.transaction('maintenance').objectStore('maintenance').get('unrelated').onsuccess = event => resolve(event.target.result) })
  assert.equal(unknown.value, 42)
})

test('aborted checkpoint leaves coverage unchanged', async t => {
  const { coverage } = await coverageFixture(t)
  await coverage.reconcile([1])
  const rows = await coverage.read(relay, [1])
  const controller = new AbortController()
  const operation = coverage.mark(rows, 0, 100, controller.signal)
  controller.abort()
  await assert.rejects(operation)
  assert.deepEqual((await coverage.read(relay, [1]))[0].intervals, [])
})

test('coverage pipelines record reads and skips repeated checkpoint writes', async t => {
  const { coverage } = await coverageFixture(t)
  await coverage.reconcile(kinds)

  let gets = 0
  let getsAtFirstResponse
  const originalGet = IDBObjectStore.prototype.get
  const getMock = t.mock.method(IDBObjectStore.prototype, 'get', function (key) {
    const read = originalGet.call(this, key)
    if (coverageKey(key)) {
      gets++
      if (gets === 1) read.addEventListener('success', () => { getsAtFirstResponse = gets })
    }
    return read
  })
  const rows = await coverage.read(relay, kinds)
  assert.equal(gets, kinds.length)
  assert.equal(getsAtFirstResponse, kinds.length)
  getMock.mock.restore()

  let writes = 0
  const originalPut = IDBObjectStore.prototype.put
  const putMock = t.mock.method(IDBObjectStore.prototype, 'put', function (value, ...args) {
    if (coverageKey(value?.key)) writes++
    return originalPut.call(this, value, ...args)
  })
  gets = 0
  getsAtFirstResponse = undefined
  t.mock.method(IDBObjectStore.prototype, 'get', function (key) {
    const read = originalGet.call(this, key)
    if (coverageKey(key)) {
      gets++
      if (gets === 1) read.addEventListener('success', () => { getsAtFirstResponse = gets })
    }
    return read
  })

  await coverage.mark(rows, 0, 100)
  assert.equal(gets, kinds.length)
  assert.equal(getsAtFirstResponse, kinds.length)
  assert.equal(writes, kinds.length)

  gets = 0
  getsAtFirstResponse = undefined
  writes = 0
  await coverage.mark(rows, 0, 100)
  assert.equal(gets, kinds.length)
  assert.equal(getsAtFirstResponse, kinds.length)
  assert.equal(writes, 0)
  putMock.mock.restore()
})

test('coverage batches concurrent ranges into one transaction per database', async t => {
  const { coverage, db } = await coverageFixture(t)
  await coverage.reconcile(kinds)
  const rows = await coverage.read(relay, kinds)
  let transactions = 0
  const originalTransaction = db.transaction.bind(db)
  t.mock.method(db, 'transaction', (...args) => {
    if (args[0] === 'maintenance' && args[1] === 'readwrite') transactions++
    return originalTransaction(...args)
  })

  let gets = 0
  const originalGet = IDBObjectStore.prototype.get
  t.mock.method(IDBObjectStore.prototype, 'get', function (key) {
    if (coverageKey(key)) gets++
    return originalGet.call(this, key)
  })

  await coverage.markBatch([
    { records: rows, since: 0, until: 100 },
    { records: rows, since: 101, until: 200 },
    { records: rows, since: 50, until: 150 }
  ])
  assert.equal(transactions, 1)
  assert.equal(gets, kinds.length)
  assert.ok((await coverage.read(relay, kinds)).every(row =>
    row.intervals.length === 1 && row.intervals[0][0] === 0 && row.intervals[0][1] === 200))
})

test('coverage read and write failures abort the whole checkpoint', async t => {
  const { coverage } = await coverageFixture(t)
  await coverage.reconcile([1])
  const rows = await coverage.read(relay, [1])

  let failGet = true
  const originalGet = IDBObjectStore.prototype.get
  const getMock = t.mock.method(IDBObjectStore.prototype, 'get', function (key) {
    if (failGet && coverageKey(key)) {
      failGet = false
      const failed = { onsuccess: null, onerror: null, error: new Error('coverage get failed') }
      queueMicrotask(() => failed.onerror())
      return failed
    }
    return originalGet.call(this, key)
  })
  await assert.rejects(coverage.mark(rows, 0, 100), /coverage get failed/)
  getMock.mock.restore()
  assert.deepEqual((await coverage.read(relay, [1]))[0].intervals, [])

  const originalPut = IDBObjectStore.prototype.put
  const putMock = t.mock.method(IDBObjectStore.prototype, 'put', function (value, ...args) {
    if (coverageKey(value?.key)) throw new Error('coverage put failed')
    return originalPut.call(this, value, ...args)
  })
  await assert.rejects(coverage.mark(rows, 0, 100), /coverage put failed/)
  putMock.mock.restore()
  assert.deepEqual((await coverage.read(relay, [1]))[0].intervals, [])
})
