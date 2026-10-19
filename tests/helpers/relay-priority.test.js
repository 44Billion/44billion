import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { isPriorityPublication, canUseSendCredit, priorityIndex, sendQueueIndex } from '#services/relay-pool/priority.js'
import { createBridgeReceiveQueue } from '#services/relay-pool/bridge-receive-queue.js'
import { RELAY_POOL_LIMITS } from '#services/relay-pool/constants.js'

const publication = (id, kind = 26300, tags = []) => JSON.stringify(['EVENT', { id, kind, tags, sig: 'signature' }])
const vaultPolicy = new URL('../../../ez-vault/src/services/relay-priority.js', import.meta.url)
test('vault and launcher use identical priority policy', { skip: !existsSync(vaultPolicy) }, () => {
  assert.equal(readFileSync(new URL('../../src/services/relay-pool/priority.js', import.meta.url), 'utf8'), readFileSync(vaultPolicy, 'utf8'))
})

test('kinds/chunks and credit reserves are bounded', () => {
  for (const kind of [9, 1063, 3560, 26300, 26400]) assert.equal(isPriorityPublication(publication('id', kind)), true)
  assert.equal(isPriorityPublication(publication('id', 34601)), false)
  assert.equal(isPriorityPublication(publication('id', 26300, [['i', '12']])), false)
  const item = { data: publication('normal', 1), size: 200, priority: false }
  assert.equal(canUseSendCredit(item, { frames: 4, bytes: 32768 }, RELAY_POOL_LIMITS), false)
  assert.equal(canUseSendCredit({ ...item, priority: true }, { frames: 4, bytes: 32768 }, RELAY_POOL_LIMITS), true)
  const queue = [{ priority: false, size: 900 }, { priority: true, size: 10 }, { priority: false, size: 10 }]
  assert.equal(priorityIndex(queue, 0, item => item.size < 100), 1)
  queue.splice(1, 1)
  assert.equal(priorityIndex(queue, 0, item => item.size < 100), -1)
})

test('correlated OK bypasses queued history, uses reserved credit, and ledger follows actual dispatch', t => {
  const frames = []; const failures = []
  const receive = createBridgeReceiveQueue({ endpointId: 'priority', virtualId: 'v', owner: 'app', relay: 'relay', limits: RELAY_POOL_LIMITS, onFrame: (data, sequence) => frames.push({ data, sequence }), onClose: (...args) => failures.push(args), onOverflow: () => {} })
  t.after(() => receive.close())
  const first = JSON.stringify(['EVENT', 'sub', { content: 'x'.repeat(970000) }])
  const next = JSON.stringify(['EVENT', 'sub', { content: 'y'.repeat(100000) }])
  receive.push(first); receive.push(next); receive.push('["EOSE","sub"]')
  receive.noteOutgoing(publication('priority'))
  receive.push('["OK","unrelated",true,""]')
  receive.push('["OK","priority",false,"rate-limited: busy"]')
  assert.deepEqual(frames.map(frame => JSON.parse(frame.data)[0]), ['EVENT', 'OK'])
  const firstBytes = frames.reduce((sum, frame) => sum + frame.data.length, 0)
  receive.grant({ frames: 2, bytes: firstBytes, through: 2 })
  assert.deepEqual(frames.map(frame => JSON.parse(frame.data)[0]), ['EVENT', 'OK', 'EVENT', 'EOSE', 'OK'])
  receive.grant({ frames: 3, bytes: frames.slice(2).reduce((sum, frame) => sum + frame.data.length, 0), through: 5 })
  assert.equal(failures.length, 0)
  assert.equal(receive.snapshot().queuedFrames, 0)
})

test('bridge weights preserve normal service under a saturated reserved window and admit large frames alone', () => {
  const normal = { data: publication('normal', 1), size: 200, priority: false }
  const high = { data: publication('priority'), size: 200, priority: true }
  const credit = { frames: 4, bytes: 32768 }
  assert.equal(sendQueueIndex([normal, high], 0, credit, RELAY_POOL_LIMITS), 1)
  assert.equal(sendQueueIndex([normal, high], 3, credit, RELAY_POOL_LIMITS), 0)
  const large = { ...normal, size: 300000 }
  assert.equal(sendQueueIndex([large, high], 3, credit, RELAY_POOL_LIMITS), -1)
  assert.equal(sendQueueIndex([large, high], 3, { frames: RELAY_POOL_LIMITS.bridgeCreditFrames, bytes: RELAY_POOL_LIMITS.bridgeCreditBytes }, RELAY_POOL_LIMITS), 0)
  assert.equal(canUseSendCredit({ data: '["OTHER"]', size: 1, priority: false }, credit, RELAY_POOL_LIMITS), true)
})
