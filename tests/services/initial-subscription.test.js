import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withInitialResults } from '../../src/services/idb/nostrdb/initial-subscription.js'
const value = (id, score, algorithm = 'sync') => ({ type: 'event', event: { id }, meta: { algorithm, sort: 'asc', score } })
test('snapshot metadata, one eose, bounded overlap and new sync anchors', async () => {
  const queue = [value('a', 1), value('a', 2), value('b', 3)]
  const live = { next: async () => ({ value: queue.shift(), done: false }), return: async () => {} }
  const stream = withInitialResults(live, async () => ({ results: [{ id: 'a' }], meta: { algorithm: 'sync', sort: 'asc', scores: [1] } }), () => queue.length)
  assert.deepEqual((await stream.next()).value, value('a', 1))
  assert.deepEqual((await stream.next()).value, { type: 'eose' })
  assert.deepEqual((await stream.next()).value, value('a', 2))
  assert.deepEqual((await stream.next()).value, value('b', 3))
  queue.push(value('a', 1))
  assert.deepEqual((await stream.next()).value, value('a', 1), 'deduplication ends after the initial overlap')
  await stream.return()
})
test('empty snapshot emits eose; failure closes without eose; cancellation drops pending snapshot', async () => {
  let closed = 0
  const live = { return: async () => { closed++ } }
  const empty = withInitialResults(live, async () => ({ results: [], meta: {} }))
  assert.deepEqual((await empty.next()).value, { type: 'eose' }); await empty.return()
  const failed = withInitialResults(live, async () => { throw new Error('read failed') })
  await assert.rejects(failed.next(), /read failed/); assert.equal(closed, 2)
  const pending = Promise.withResolvers()
  const cancelled = withInitialResults(live, () => pending.promise)
  const read = cancelled.next(); await cancelled.return(); pending.resolve({ results: ['x'] })
  assert.deepEqual(await read, { done: true })
})
