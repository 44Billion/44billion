import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAccountCoverageCheckpointQueue } from '../../src/services/account-coverage-checkpoints.js'

const request = (since, until, signal) => ({ records: [{ key: `kind-${since}` }], since, until, signal })

test('checkpoint queue combines requests per coverage database', async () => {
  const calls = []
  const coverage = { async markBatch (requests) { calls.push(requests) } }
  const queue = createAccountCoverageCheckpointQueue()
  queue.queue(coverage, request(0, 99))
  queue.queue(coverage, request(100, 199))
  queue.queue(coverage, request(50, 149))
  await queue.flush()

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].map(value => [value.since, value.until]), [[0, 99], [100, 199], [50, 149]])
  queue.stop()
})

test('aborted requests are omitted and checkpoint failures reach the flush barrier', async () => {
  const controller = new AbortController()
  let received
  const coverage = {
    async markBatch (requests) {
      received = requests
      throw Object.assign(new Error('coverage failed'), { code: 'COVERAGE_FAILED' })
    }
  }
  const queue = createAccountCoverageCheckpointQueue()
  queue.queue(coverage, request(0, 10, controller.signal))
  queue.queue(coverage, request(20, 30))
  controller.abort()

  await assert.rejects(queue.flush(), { code: 'COVERAGE_FAILED' })
  assert.deepEqual(received.map(value => [value.since, value.until]), [[20, 30]])
  queue.stop()
})

test('the timer drains pending checkpoints without losing a later flush', async () => {
  const scheduled = []
  let calls = 0
  const coverage = { async markBatch () { calls++ } }
  const queue = createAccountCoverageCheckpointQueue({
    delay: 50,
    setTimer: callback => { scheduled.push(callback); return 1 },
    clearTimer: () => {}
  })
  queue.queue(coverage, request(0, 10))
  assert.equal(scheduled.length, 1)
  scheduled.shift()()
  await queue.flush()
  assert.equal(calls, 1)
  queue.stop()
})
