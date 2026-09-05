import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInstanceMetadataClient } from '../../src/helpers/window-message/instance-metadata-client.js'

const metadata = extra => ({ instanceKey: 'self', isWidget: true, isPinned: false, isLoaded: true, isVisible: false, otherInstances: [], ...extra })
const tick = () => new Promise(resolve => queueMicrotask(resolve))

test('getter waits for handshake and returns the latest independent snapshot on every call', async () => {
  const client = createInstanceMetadataClient()
  let resolved = false
  const initial = client.getInstanceMetadata().then(value => { resolved = true; return value })
  await tick()
  assert.equal(resolved, false)
  const source = metadata({ otherInstances: [{ instanceKey: 'other', isWidget: false, isPinned: false, isLoaded: false, isVisible: false }] })
  client.setMetadata(source)
  source.otherInstances[0].instanceKey = 'mutated-source'
  const first = await initial
  first.otherInstances[0].instanceKey = 'mutated-result'
  assert.equal((await client.getInstanceMetadata()).otherInstances[0].instanceKey, 'other')
  client.setMetadata(metadata({ isVisible: true }))
  assert.equal((await client.getInstanceMetadata()).isVisible, true)
})

test('subscriptions receive the initial state asynchronously, then only changes', async () => {
  const client = createInstanceMetadataClient()
  const early = []
  client.onInstanceMetadataChanged(value => early.push(value))
  client.setMetadata(metadata())
  assert.equal(early.length, 0)
  await tick()
  assert.equal(early.length, 1)
  client.setMetadata(metadata())
  await tick()
  assert.equal(early.length, 1)
  const late = []
  client.onInstanceMetadataChanged(value => late.push(value))
  assert.equal(late.length, 0)
  await tick()
  assert.deepEqual(late, early)
  client.setMetadata(metadata({ isVisible: true }))
  await tick()
  assert.equal(late.at(-1).isVisible, true)
  assert.equal(early.length, 2)
})

test('unsubscribe is immediate and idempotent, including before readiness or queued delivery', async () => {
  const client = createInstanceMetadataClient()
  let deliveries = 0
  const listener = () => { deliveries++ }
  const before = client.onInstanceMetadataChanged(listener)
  before(); before()
  client.setMetadata(metadata())
  const after = client.onInstanceMetadataChanged(listener)
  after()
  await tick()
  client.setMetadata(metadata({ isVisible: true }))
  await tick()
  assert.equal(deliveries, 0)
  assert.throws(() => client.onInstanceMetadataChanged(null), TypeError)
})

test('callback mutation and sync/async failures do not affect other listeners', async () => {
  const errors = []
  const seen = []
  const client = createInstanceMetadataClient({ reportError: error => errors.push(error.message) })
  client.onInstanceMetadataChanged(value => { value.instanceKey = 'mutated'; throw new Error('sync') })
  client.onInstanceMetadataChanged(async () => { throw new Error('async') })
  client.onInstanceMetadataChanged(value => seen.push(value.instanceKey))
  client.setMetadata(metadata())
  await tick(); await tick()
  assert.deepEqual(seen, ['self'])
  assert.deepEqual(errors.sort(), ['async', 'sync'])
  assert.equal((await client.getInstanceMetadata()).instanceKey, 'self')
})

test('registering the same callback twice creates independently cancellable subscriptions', async () => {
  const client = createInstanceMetadataClient()
  const seen = []
  const listener = value => seen.push(value)
  const cancelFirst = client.onInstanceMetadataChanged(listener)
  client.onInstanceMetadataChanged(listener)
  cancelFirst()
  client.setMetadata(metadata())
  await tick()
  assert.equal(seen.length, 1)
})
