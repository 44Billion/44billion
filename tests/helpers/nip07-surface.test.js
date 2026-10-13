import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { createNip07Method } from '../../src/helpers/window-message/nip07-client.js'

const source = readFileSync(new URL('../../src/scripts/app-page.txt.js', import.meta.url), 'utf8')
const injection = source.slice(source.indexOf('function injectNip07 ('), source.indexOf('// Intercept and cancel navigations'))
const owner = 'a'.repeat(64)
const peer = 'b'.repeat(64)

function setup () {
  const handshake = Promise.withResolvers()
  const requests = []
  const context = vm.createContext({
    window: {}, createNip07Method,
    ask: async (_, message) => { requests.push(message); return { payload: 'result' } },
    tell: () => {}, originalConsole: { warn: () => {} }
  })
  vm.runInContext(injection, context)
  const capabilities = context.injectNip07(handshake.promise)
  return { ...handshake, ...context.window, ...capabilities, requests }
}

function assertContentMethods (signer, supported) {
  assert.equal('doubleSignEvent' in signer, supported)
  assert.equal('encryptDoubleDH' in signer.nip44v3, supported)
  assert.equal('decryptDoubleDH' in signer.nip44v3, supported)
  for (const method of [signer.signEvent, signer.nip44.encrypt, signer.nip44v3.encrypt, signer.nip44v3.decrypt]) {
    assert.equal(typeof method, 'function')
  }
}

test('bunker and unknown signer surfaces omit content-key methods in every context', () => {
  const { nostr, napp, setCapabilities } = setup()
  const ownerSurfaces = [nostr, nostr.ns('notes'), nostr.withSharedKey(owner, 'scope')]
  const scoped = napp.getWindowNostrFor(peer)
  const peerSurfaces = [scoped, scoped.ns('notes'), scoped.withSharedKey(peer, 'scope')]
  for (const signer of [...ownerSurfaces, ...peerSurfaces]) assertContentMethods(signer, false)
  // Owner is a bunker; the persona peer is a local nsec.
  setCapabilities({ ownerPubkey: owner, pubkeysSupportingContentKeyMethods: [peer] })
  for (const signer of ownerSurfaces) assertContentMethods(signer, false)
  for (const signer of peerSurfaces) assertContentMethods(signer, true)
  assertContentMethods(nostr.ns('later'), false)
  assertContentMethods(napp.getWindowNostrFor(peer).ns('later'), true)
})

test('existing objects follow type changes and persona removal without leaking support between identities', () => {
  const { nostr, napp, setCapabilities } = setup()
  const ownerNamespace = nostr.ns('notes')
  const peerSigner = napp.getWindowNostrFor(peer)
  const peerShared = peerSigner.withSharedKey(owner, 'scope')
  setCapabilities({ ownerPubkey: owner, pubkeysSupportingContentKeyMethods: [owner, peer] })
  for (const signer of [nostr, ownerNamespace, peerSigner, peerShared]) assertContentMethods(signer, true)
  for (const pubkey of [undefined, null, '', 'invalid']) assertContentMethods(napp.getWindowNostrFor(pubkey), false)
  setCapabilities({ ownerPubkey: owner, pubkeysSupportingContentKeyMethods: [owner] })
  assertContentMethods(nostr, true)
  assertContentMethods(peerSigner, false)
  assertContentMethods(peerShared, false)
  setCapabilities({ ownerPubkey: owner, pubkeysSupportingContentKeyMethods: [peer] })
  assertContentMethods(nostr, false)
  assertContentMethods(ownerNamespace, false)
  assertContentMethods(peerSigner, true)
  setCapabilities({ ownerPubkey: owner, pubkeysSupportingContentKeyMethods: [] })
  assertContentMethods(peerSigner, false)
})

test('nsec methods keep wire names, scope and binary snapshots; stale functions cannot reach the transport', async () => {
  const { nostr, napp, resolve, setCapabilities, requests } = setup()
  setCapabilities({ ownerPubkey: owner, pubkeysSupportingContentKeyMethods: [owner, peer] })
  const signer = napp.getWindowNostrFor(peer).withSharedKey(owner, 'scope')
  const bytes = new Uint8Array([1, 2, 3])
  const encrypt = signer.nip44v3.encryptDoubleDH(owner, 9, '', bytes.buffer)
  bytes.fill(0)
  resolve({})
  await encrypt
  assert.equal(requests[0].payload.method, 'nip44v3_encrypt_double_dh')
  assert.equal(requests[0].payload.userPk, peer)
  assert.deepEqual([...requests[0].payload.with_shared_key], [owner, 'scope'])
  assert.deepEqual(new Uint8Array(requests[0].payload.params[3]), new Uint8Array([1, 2, 3]))
  await nostr.ns('notes').doubleSignEvent({ kind: 1 })
  assert.equal(requests[1].payload.method, 'double_sign_event')
  assert.deepEqual([...requests[1].payload.ns], ['notes'])
  const captured = nostr.doubleSignEvent
  setCapabilities({ ownerPubkey: owner, pubkeysSupportingContentKeyMethods: [peer] })
  await assert.rejects(captured({ kind: 1 }), { code: 'UNSUPPORTED_METHOD' })
  assert.equal(requests.length, 2)
})
