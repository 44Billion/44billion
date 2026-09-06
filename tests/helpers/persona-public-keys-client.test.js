import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPersonaPublicKeysClient } from '../../src/helpers/window-message/persona-public-keys-client.js'

const a = '11'.repeat(32)
const b = '22'.repeat(32)
const tick = () => new Promise(resolve => queueMicrotask(resolve))

test('subscriptions receive initial keys asynchronously and only changed sets thereafter', async () => {
  const client = createPersonaPublicKeysClient()
  const early = []
  client.onPersonaPublicKeysChanged(keys => early.push(keys))
  client.setPublicKeys([a])
  assert.deepEqual(early, [])
  await tick()
  client.setPublicKeys([a, b])
  await tick()
  client.setPublicKeys([b, a])
  client.setPublicKeys([a, b, a])
  await tick()
  assert.deepEqual(early, [[a], [a, b]])
  const late = []
  client.onPersonaPublicKeysChanged(keys => late.push(keys))
  assert.deepEqual(late, [])
  await tick()
  assert.deepEqual(late, [[a, b]])
  client.setPublicKeys([a])
  await tick()
  assert.deepEqual(early.at(-1), [a])
  assert.deepEqual(late.at(-1), [a])
})

test('cancellation is immediate and independent, even before the handshake or queued delivery', async () => {
  const client = createPersonaPublicKeysClient()
  const seen = []
  const listener = keys => seen.push(keys)
  const early = client.onPersonaPublicKeysChanged(listener)
  early(); early()
  client.setPublicKeys([])
  const first = client.onPersonaPublicKeysChanged(listener)
  client.onPersonaPublicKeysChanged(listener)
  first()
  await tick()
  assert.deepEqual(seen, [[]])
  assert.throws(() => client.onPersonaPublicKeysChanged(null), TypeError)
})

test('source and listener mutations, invalid messages and failing listeners are isolated', async () => {
  const errors = []
  const client = createPersonaPublicKeysClient({ reportError: error => errors.push(error.message) })
  const seen = []
  client.onPersonaPublicKeysChanged(keys => { keys.push(b); throw new Error('sync') })
  client.onPersonaPublicKeysChanged(async () => { throw new Error('async') })
  client.onPersonaPublicKeysChanged(keys => seen.push(keys))
  const source = [a]
  client.setPublicKeys(source)
  source.push(b)
  client.setPublicKeys(null)
  client.setPublicKeys(['bad'])
  await tick(); await tick()
  assert.deepEqual(seen, [[a]])
  assert.deepEqual(errors.sort(), ['async', 'sync'])
})
