import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSignerStateService } from '../../src/services/signer-state.js'
import { createSignerStateClient } from '../../src/helpers/window-message/signer-state-client.js'

const owner = 'a'.repeat(64)
const peer = 'b'.repeat(64)

test('content-key revisions are private, deduplicated, account-scoped and revoked with persona access', () => {
  const service = createSignerStateService()
  let keys = [peer]
  const states = []
  const scope = { ownerPubkey: owner, pubkey: peer, readKeys: () => keys }
  const stop = service.subscribeContentKeys(scope, (state, revoked) => states.push({ state, revoked: !!revoked }))
  assert.deepEqual(Object.keys(states[0].state).sort(), ['pubkey', 'revision'])
  const initial = states[0].state.revision
  service.contentKeysChanged(owner)
  service.invalidate()
  assert.equal(states.length, 1)
  service.contentKeysChanged(peer)
  assert.notEqual(states[1].state.revision, initial)
  keys = []
  service.invalidate()
  assert.equal(states.at(-1).revoked, true)
  const count = states.length
  service.contentKeysChanged(peer)
  assert.equal(states.length, count)
  assert.throws(() => service.subscribeContentKeys(scope, () => {}), { code: 'PUBKEY_NOT_IN_PERSONA' })
  stop()
})

test('content-key client uses the scoped subscription, initial callback and cancellation contract', async () => {
  const requests = []
  const states = []
  const client = createSignerStateClient({ handshake: Promise.resolve({}), ask: async (_, message) => { requests.push(message); return { payload: true } }, tell: () => {}, reportError: () => {} })
  const stop = client.onSignerStateChanged(value => states.push(value), { pubkey: peer }, true)
  await stop.ready
  assert.equal(requests[0].code, 'CONTENT_KEYS_SUBSCRIBE')
  const id = requests[0].payload.id
  client.receive({ id, state: { pubkey: peer, revision: 'revision' } })
  await Promise.resolve()
  assert.deepEqual(states, [{ pubkey: peer, revision: 'revision' }])
  client.receive({ id, state: { pubkey: peer, revision: 'stale' } })
  stop()
  await Promise.resolve()
  assert.equal(states.length, 1)
  client.close()
})
test('signer state reports lock changes without persona changes and revokes without account details', () => {
  const service = createSignerStateService()
  let keys = [owner, peer]
  const scope = { ownerPubkey: owner, pubkey: peer, readKeys: () => keys }
  const states = []
  const stop = service.subscribe(scope, state => states.push(state))
  assert.equal(states[0].connection, 'unknown')
  service.setAccounts([{ pubkey: peer, isLocked: true, isReadOnly: false }])
  service.setConnection('connected')
  service.setAccounts([{ pubkey: peer, isLocked: false, isReadOnly: false }])
  assert.equal(states.at(-1).isLocked, false)
  service.setAccounts([{ pubkey: peer, isLocked: false, isReadOnly: true }])
  assert.equal(states.at(-1).isReadOnly, true)
  keys = [owner]
  service.invalidate()
  assert.deepEqual(states.at(-1), { pubkey: peer, connection: 'unknown', access: 'revoked', isDefaultUser: null, supportsContentKeyMethods: null, isLocked: null, isReadOnly: null })
  const count = states.length
  service.setConnection('disconnected')
  assert.equal(states.length, count)
  assert.throws(() => service.read(scope), { code: 'PUBKEY_NOT_IN_PERSONA' })
  stop()
})

test('signer client suppresses queued callbacks on unsubscribe and exposes setup rejection', async () => {
  const requests = []
  const client = createSignerStateClient({ handshake: Promise.resolve({}), ask: async (_, message) => { requests.push(message); return { payload: true } }, tell: () => {}, reportError: () => {} })
  const states = []
  const stop = client.onSignerStateChanged(state => states.push(state), { pubkey: peer })
  await stop.ready
  client.receive({ id: requests[0].payload.id, state: { pubkey: peer, access: 'allowed' } })
  stop()
  await Promise.resolve()
  assert.deepEqual(states, [])
  const error = Object.assign(new Error('denied'), { code: 'PUBKEY_NOT_IN_PERSONA' })
  const denied = createSignerStateClient({ handshake: Promise.resolve({}), ask: async () => ({ error }), tell: () => {}, reportError: () => {} })
  await assert.rejects(denied.getSignerState({ pubkey: peer }), error)
  await assert.rejects(denied.onSignerStateChanged(() => {}, { pubkey: peer }).ready, error)
  client.close(); denied.close()
})

test('public signer state distinguishes signed-out identities and notifies on capability-only changes', () => {
  const service = createSignerStateService()
  const scope = { ownerPubkey: owner, readKeys: () => [], readFlags: () => ({ isDefaultUser: true, isReadOnly: false, isLocked: false }) }
  assert.equal(service.read(scope).isDefaultUser, true)
  assert.equal(service.read(scope).connection, 'unknown')
  assert.equal(service.read({ ...scope, readFlags: () => ({ isReadOnly: true }) }).isDefaultUser, false)
  const updates = []
  const order = []
  service.setAccounts([{ pubkey: owner, isReadOnly: false, isLocked: false, supportsContentKeyMethods: false }])
  service.setConnection('connected')
  service.subscribeContentKeyCapabilities(scope, () => order.push('surface'))
  service.subscribe({ ...scope, readFlags: () => ({ isDefaultUser: false }) }, state => { updates.push(state); order.push('state') })
  order.length = 0
  service.setAccounts([{ pubkey: owner, isReadOnly: false, isLocked: false, supportsContentKeyMethods: true }])
  assert.deepEqual(order, ['surface', 'state'])
  assert.equal(updates.at(-1).supportsContentKeyMethods, true)
  assert.equal(updates.at(-1).isDefaultUser, false)
  assert.equal(updates.at(-1).isLocked, updates.at(-2).isLocked)
  assert.equal(updates.at(-1).isReadOnly, updates.at(-2).isReadOnly)
})

test('signer port scopes identities, sends initial state before reply and stops on unload', async () => {
  globalThis.IS_DEVELOPMENT = false
  const { signerStates } = await import('../../src/services/signer-state.js')
  const { connectSignerStatePort } = await import('../../src/helpers/window-message/signer-state-port.js')
  let keys = [owner, peer]
  const port = new EventTarget()
  const messages = []
  port.postMessage = message => messages.push(message)
  const controller = new AbortController()
  signerStates.setConnection('connected')
  signerStates.setAccounts([{ pubkey: owner, isLocked: false, isReadOnly: false }, { pubkey: peer, isLocked: true, isReadOnly: false }])
  connectSignerStatePort({ port, signal: controller.signal, ownerPubkey: owner, readKeys: () => keys })
  const send = (code, payload) => port.dispatchEvent(new MessageEvent('message', { data: { code, payload, reqId: 'request' } }))
  send('SIGNER_STATE_SUBSCRIBE', { id: 'peer', pubkey: peer })
  assert.equal(messages[0].code, 'SIGNER_STATE_CHANGED')
  assert.equal(messages[0].payload.state.isLocked, true)
  assert.equal(messages[1].code, 'REPLY')
  send('SIGNER_STATE_SUBSCRIBE', { id: 'owner' })
  signerStates.setAccounts([{ pubkey: owner, isLocked: true, isReadOnly: false }, { pubkey: peer, isLocked: false, isReadOnly: true }])
  assert.equal(messages.at(-1).payload.state.pubkey, owner)
  keys = [owner]; signerStates.invalidate()
  assert.equal(messages.at(-1).payload.state.access, 'revoked')
  send('SIGNER_STATE_GET', { pubkey: peer })
  assert.equal(messages.at(-1).error.context.code, 'PUBKEY_NOT_IN_PERSONA')
  send('INSTANCE_DOCUMENT_UNLOADED')
  const count = messages.length
  signerStates.setConnection('disconnected')
  assert.equal(messages.length, count)
  controller.abort()
})

test('connection probes are serial, recover availability and ignore results from a replaced port', async () => {
  const { watchSignerConnection } = await import('../../src/services/signer-connection.js')
  const controller = new AbortController(); const states = []; const timers = []
  let response = false
  watchSignerConnection({ ping: async () => response, update: value => states.push(value), signal: controller.signal, setTimer: callback => { timers.push(callback); return callback }, clearTimer: callback => { const i = timers.indexOf(callback); if (i >= 0) timers.splice(i, 1) } })
  await timers.shift()()
  assert.deepEqual(states, ['disconnected']); assert.equal(timers.length, 1)
  response = true
  await timers.shift()()
  assert.deepEqual(states, ['disconnected', 'connected'])
  const late = timers.shift(); controller.abort(); await late()
  assert.equal(states.length, 2); assert.equal(timers.length, 0)
})

test('content-key capabilities use vault metadata, stay scoped to the persona and survive local account locking', () => {
  const service = createSignerStateService()
  let keys = [peer]
  const snapshots = []
  const scope = { ownerPubkey: owner, readKeys: () => keys }
  const stop = service.subscribeContentKeyCapabilities(scope, snapshot => snapshots.push(snapshot))
  assert.deepEqual(snapshots[0], { ownerPubkey: owner, pubkeysSupportingContentKeyMethods: [] })
  service.setAccounts([
    { pubkey: owner, supportsContentKeyMethods: false },
    { pubkey: peer, supportsContentKeyMethods: true, isLocked: true },
    { pubkey: 'c'.repeat(64), supportsContentKeyMethods: true }
  ])
  assert.deepEqual(snapshots.at(-1).pubkeysSupportingContentKeyMethods, [peer])
  service.setAccounts([{ pubkey: owner, supportsContentKeyMethods: true, isLocked: true }])
  assert.deepEqual(snapshots.at(-1).pubkeysSupportingContentKeyMethods, [owner])
  service.setAccounts([{ pubkey: owner, isReadOnly: true }, { pubkey: peer, supportsContentKeyMethods: true }])
  assert.deepEqual(snapshots.at(-1).pubkeysSupportingContentKeyMethods, [peer])
  keys = []; service.invalidate()
  assert.deepEqual(snapshots.at(-1).pubkeysSupportingContentKeyMethods, [])
  keys = [peer]; service.invalidate()
  assert.deepEqual(snapshots.at(-1).pubkeysSupportingContentKeyMethods, [peer])
  stop()
  const count = snapshots.length
  service.setAccounts([])
  assert.equal(snapshots.length, count)
})

test('capability port returns the handshake snapshot without an early message and disposes on unload', async () => {
  const { signerStates } = await import('../../src/services/signer-state.js')
  const { connectSignerCapabilitiesPort } = await import('../../src/helpers/window-message/signer-state-port.js')
  const port = new EventTarget()
  const messages = []
  port.postMessage = message => messages.push(message)
  const controller = new AbortController()
  signerStates.setAccounts([{ pubkey: owner, supportsContentKeyMethods: true }])
  const initial = connectSignerCapabilitiesPort({ port, signal: controller.signal, ownerPubkey: owner, readKeys: () => [] })
  assert.deepEqual(initial, { ownerPubkey: owner, pubkeysSupportingContentKeyMethods: [owner] })
  assert.deepEqual(messages, [])
  signerStates.setAccounts([{ pubkey: owner, supportsContentKeyMethods: false }])
  assert.deepEqual(messages[0], { code: 'NIP07_CAPABILITIES_CHANGED', payload: { ownerPubkey: owner, pubkeysSupportingContentKeyMethods: [] } })
  port.dispatchEvent(new MessageEvent('message', { data: { code: 'INSTANCE_DOCUMENT_UNLOADED' } }))
  signerStates.setAccounts([{ pubkey: owner, supportsContentKeyMethods: true }])
  assert.equal(messages.length, 1)
  controller.abort()
})
