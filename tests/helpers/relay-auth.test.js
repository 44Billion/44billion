import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createRelayAuthProvider,
  createVaultRelayAuthProvider,
  RELAY_AUTH_KIND,
  RELAY_AUTH_TIMEOUT_MS
} from '#services/relay-pool/auth.js'

describe('relay auth provider', () => {
  it('signs a strict NIP-42 template for the requested account and relay', async () => {
    const calls = []
    const provider = createRelayAuthProvider({
      now: () => 1700000000,
      canAuthenticate: pubkey => pubkey === 'alice',
      signEvent: async (event, pubkey) => {
        calls.push({ event, pubkey })
        return { ...event, pubkey, id: 'signed', sig: 'signature' }
      }
    })
    assert.equal(RELAY_AUTH_KIND, 22242)
    assert.equal(await provider.canAuthenticate('alice'), true)
    assert.equal(await provider.canAuthenticate('bob'), false)
    assert.deepEqual(await provider.signAuth({
      relay: 'wss://relay.example',
      challenge: 'challenge-value',
      pubkey: 'alice'
    }), {
      kind: 22242,
      created_at: 1700000000,
      tags: [
        ['relay', 'wss://relay.example'],
        ['challenge', 'challenge-value']
      ],
      content: '',
      pubkey: 'alice',
      id: 'signed',
      sig: 'signature'
    })
    assert.deepEqual(calls, [{
      event: {
        kind: 22242,
        created_at: 1700000000,
        tags: [
          ['relay', 'wss://relay.example'],
          ['challenge', 'challenge-value']
        ],
        content: ''
      },
      pubkey: 'alice'
    }])
  })

  it('rejects incomplete providers and requests before consulting the signer', async () => {
    assert.throws(() => createRelayAuthProvider({ canAuthenticate: () => true }), {
      message: 'INVALID_RELAY_AUTH_PROVIDER'
    })
    let signed = false
    const provider = createRelayAuthProvider({
      canAuthenticate: () => true,
      signEvent: () => { signed = true }
    })
    await assert.rejects(provider.signAuth({ relay: 'wss://relay.example', challenge: '', pubkey: 'alice' }), {
      message: 'INVALID_RELAY_AUTH_REQUEST'
    })
    assert.equal(signed, false)
  })

  it('uses the vault queue priority and short timeout for launcher/vault AUTH', async () => {
    const calls = []
    const pubkey = 'a'.repeat(64)
    const provider = createVaultRelayAuthProvider({
      askVault: async (message, options) => {
        calls.push({ message, options })
        return { payload: { id: 'signed-vault-auth' } }
      }
    })
    assert.equal(await provider.canAuthenticate(pubkey), true)
    assert.equal(await provider.canAuthenticate('not-hex'), false)
    assert.deepEqual(await provider.signAuth({
      relay: 'wss://relay.example',
      challenge: 'challenge',
      pubkey
    }), { id: 'signed-vault-auth' })
    assert.equal(calls[0].message.code, 'NIP07')
    assert.equal(calls[0].message.payload.method, 'sign_event')
    assert.equal(calls[0].message.payload.pubkey, pubkey)
    assert.equal(calls[0].message.payload.params[0].kind, RELAY_AUTH_KIND)
    assert.equal(calls[0].message.payload.context, 'relay-auth')
    assert.deepEqual(calls[0].options, {
      timeout: RELAY_AUTH_TIMEOUT_MS,
      scheduling: { priority: true, chunk: false, archive: false }
    })
  })
})
