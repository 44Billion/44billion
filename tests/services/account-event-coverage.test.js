import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeCoverage, missingCoverage } from '../../src/services/account-event-coverage.js'

import { coverageFixture } from '../fixtures/account-coverage.js'

const relay = 'wss://relay.example'

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
