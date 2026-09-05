import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInstanceMetadataService } from '../../src/services/instance-metadata/index.js'

globalThis.IS_DEVELOPMENT = false
const { connectInstanceMetadataPort } = await import('../../src/helpers/window-message/instance-metadata-port.js')
const tick = () => new Promise(resolve => queueMicrotask(resolve))
const record = instanceKey => ({ instanceKey, appId: 'app', userPk: 'user', personaId: null, isWidget: false })

test('initial handshake data precedes change notifications and abort stops the old port', async () => {
  const service = createInstanceMetadataService()
  service.setCatalog([record('self'), record('other')])
  const port = new EventTarget()
  const ac = new AbortController()
  const messages = []
  const initialMetadata = connectInstanceMetadataPort(service, {
    record: record('self'), port, signal: ac.signal,
    send: (_port, message) => messages.push(message)
  })
  assert.equal(initialMetadata.isLoaded, true)
  assert.equal(initialMetadata.otherInstances[0].isLoaded, false)
  await tick()
  assert.deepEqual(messages, [])
  service.connect(record('other'), () => {})
  await tick()
  assert.equal(messages[0].code, 'INSTANCE_METADATA_CHANGED')
  assert.equal(messages[0].payload.otherInstances[0].isLoaded, true)
  ac.abort()
  service.setEnvironment({ tabVisible: false })
  await tick()
  assert.equal(messages.length, 1)
  assert.equal(service.getMetadata('self').isLoaded, false)
})

test('unload updates peers and stale document signals cannot disconnect the replacement', async () => {
  const service = createInstanceMetadataService()
  service.setCatalog([record('self'), record('peer')])
  const updates = []
  service.connect(record('peer'), value => updates.push(value))
  const oldPort = new EventTarget()
  const oldController = new AbortController()
  connectInstanceMetadataPort(service, { record: record('self'), port: oldPort, signal: oldController.signal, send: () => {} })
  await tick()
  assert.equal(updates.at(-1).otherInstances[0].isLoaded, true)
  oldPort.dispatchEvent(new MessageEvent('message', { data: { code: 'INSTANCE_DOCUMENT_UNLOADED' } }))
  await tick()
  assert.equal(updates.at(-1).otherInstances[0].isLoaded, false)
  const newController = new AbortController()
  connectInstanceMetadataPort(service, { record: record('self'), port: new EventTarget(), signal: newController.signal, send: () => {} })
  oldController.abort()
  oldPort.dispatchEvent(new MessageEvent('message', { data: { code: 'INSTANCE_DOCUMENT_UNLOADED' } }))
  await tick()
  assert.equal(service.getMetadata('self').isLoaded, true)
  newController.abort()
  assert.equal(service.getMetadata('self').isLoaded, false)
})
