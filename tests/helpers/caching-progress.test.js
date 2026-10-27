import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROGRESS_VISIBLE_AFTER_COMPLETE_MS,
  STALE_PROGRESS_MAX_AGE_MS,
  createAppFileProgressTracker,
  pruneStaleProgressEntries,
  stampProgressEntry
} from '../../src/helpers/caching-progress.js'

test('stampProgressEntry adds updatedAt without mutating the input', () => {
  const entry = { progress: 40, totalByteSizeEstimate: 100 }
  const stamped = stampProgressEntry(entry, 1234)
  assert.equal(stamped.updatedAt, 1234)
  assert.equal(stamped.progress, 40)
  assert.equal(entry.updatedAt, undefined)
})

test('pruneStaleProgressEntries removes completed entries older than maxAge', () => {
  const now = 10000
  const entries = {
    '/index.js': { progress: 100, updatedAt: now - 5000 },
    '/chunk.js': { progress: 100, updatedAt: now - 4000 },
    '/slow.js': { progress: 40, updatedAt: now - 99999 },
    _frameworkKey: 'keep'
  }
  const pruned = pruneStaleProgressEntries(entries, { now })
  assert.deepEqual(Object.keys(pruned).sort(), ['/chunk.js', '/slow.js', '_frameworkKey'])
  assert.equal(pruned['/index.js'], undefined)
  // input untouched
  assert.equal(entries['/index.js'].progress, 100)
})

test('pruneStaleProgressEntries treats a missing updatedAt as immediately stale', () => {
  const pruned = pruneStaleProgressEntries({ '/x.js': { progress: 100 } }, { now: 1000 })
  assert.deepEqual(Object.keys(pruned), [])
})

test('pruneStaleProgressEntries keeps incomplete entries regardless of age', () => {
  const entries = { '/x.js': { progress: 99, updatedAt: 0 } }
  assert.deepEqual(pruneStaleProgressEntries(entries, { now: 999999 }), entries)
})

test('defaults match the documented sweep cadence', () => {
  assert.equal(STALE_PROGRESS_MAX_AGE_MS, 5000)
  assert.equal(PROGRESS_VISIBLE_AFTER_COMPLETE_MS, 1000)
})

test('tracks Blossom completion after its final data event was already streamed', () => {
  let progress = {}
  let totalChunks = null
  let streamComplete = false
  let errored = false
  let completion
  const cleared = []
  const track = createAppFileProgressTracker({
    cachingProgress$: next => {
      if (next !== undefined) progress = next
      return progress
    },
    filename: '/lakes.json',
    getTotalChunks: () => totalChunks,
    setTotalChunks: value => { totalChunks = value },
    isErrored: () => errored,
    markErrored: () => { errored = true },
    isStreamComplete: () => streamComplete,
    onError: error => assert.fail(`unexpected error: ${error}`),
    setTimer: callback => {
      completion = callback
      return 1
    },
    clearTimer: timer => cleared.push(timer)
  })

  assert.equal(track({ progress: 99, total: 1 }), true)
  assert.equal(progress['/lakes.json'].progress, 99)
  assert.equal(totalChunks, 1)

  // The bridge streams the chunk sent with the 99% report before Blossom
  // validates the full hash and emits its separate completion report.
  streamComplete = true
  assert.equal(track({ progress: 100, total: 1 }), false)
  assert.equal(progress['/lakes.json'].progress, 100)
  assert.deepEqual(cleared, [])

  completion()
  assert.deepEqual(progress, {})
})

test('clears failed app-file progress without streaming after completion', () => {
  let progress = { '/asset.js': { progress: 50 } }
  let errored = false
  let onErrorCalled = false
  const track = createAppFileProgressTracker({
    cachingProgress$: next => {
      if (next !== undefined) progress = next
      return progress
    },
    filename: '/asset.js',
    getTotalChunks: () => 1,
    setTotalChunks: () => assert.fail('total should already be known'),
    isErrored: () => errored,
    markErrored: () => { errored = true },
    isStreamComplete: () => true,
    onError: () => { onErrorCalled = true }
  })

  assert.equal(track({ progress: 100, error: new Error('hash mismatch') }), false)
  assert.equal(errored, true)
  assert.equal(onErrorCalled, false)
  assert.deepEqual(progress, {})
})
