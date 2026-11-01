import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createAppRelayAuthProvider } from '#helpers/window-message/app-relay-auth.js'

const APP_KEY = 'app-instance'
const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)

function createProvider (overrides = {}) {
  const calls = {
    guard: [],
    metadata: 0,
    vault: [],
    attention: []
  }
  let accessible = [ALICE]
  const provider = createAppRelayAuthProvider({
    appId: 'app-id',
    appAddress: { dTag: 'app-alias' },
    appKey: APP_KEY,
    wsKey: 'workspace',
    instanceUserPk: 'owner',
    defaultUserPk: 'default',
    askVault: async (message, options) => {
      calls.vault.push({ message, options })
      return {
        payload: {
          ...message.payload.params[0],
          pubkey: message.payload.pubkey,
          id: 'signed-app-auth'
        }
      }
    },
    resolveAppMetadata: async () => {
      calls.metadata++
      return { napp: 'napp-address', name: 'Test app', alias: 'app-alias' }
    },
    notifySignerRequestAttention: info => calls.attention.push(info),
    readPublicKeys: record => {
      assert.deepEqual(record, {
        instanceKey: APP_KEY,
        appId: 'app-id',
        wsKey: 'workspace',
        instanceUserPk: 'owner'
      })
      return accessible
    },
    readAccountFlags: () => ({ isDefaultUser: false, isReadOnly: false, isLocked: false }),
    guard: info => calls.guard.push(info),
    ...overrides
  })
  return {
    provider,
    calls,
    setAccessible (keys) { accessible = keys }
  }
}

describe('app relay auth provider', () => {
  it('re-evaluates the active persona without contacting the vault for other pubkeys', async () => {
    const { provider, calls, setAccessible } = createProvider()
    assert.equal(await provider.canAuthenticate(ALICE), true)
    assert.equal(await provider.canAuthenticate(BOB), false)
    assert.equal(calls.vault.length, 0)
    setAccessible([BOB])
    assert.equal(await provider.canAuthenticate(ALICE), false)
    assert.equal(await provider.canAuthenticate(BOB), true)
  })

  it('signs through NIP-07 directly with priority and without requestPermission', async () => {
    const { provider, calls } = createProvider()
    const signed = await provider.signAuth({
      relay: 'wss://relay.example',
      challenge: 'challenge',
      pubkey: ALICE
    })
    assert.equal(signed.id, 'signed-app-auth')
    assert.deepEqual(calls.guard, [{
      method: 'sign_event',
      params: [{
        kind: 22242,
        created_at: signed.created_at,
        tags: [
          ['relay', 'wss://relay.example'],
          ['challenge', 'challenge']
        ],
        content: ''
      }],
      account: { isDefaultUser: false, isReadOnly: false, isLocked: false },
      onAttention: calls.guard[0].onAttention
    }])
    assert.equal(calls.metadata, 1)
    assert.equal(calls.vault[0].message.code, 'NIP07')
    assert.equal(calls.vault[0].message.payload.method, 'sign_event')
    assert.deepEqual(calls.vault[0].message.payload.app, {
      id: 'napp-address',
      name: 'Test app',
      alias: 'app-alias'
    })
    assert.deepEqual(calls.vault[0].options, {
      timeout: 5000,
      scheduling: { priority: true, chunk: false, archive: false }
    })
    assert.equal('requestPermission' in calls.vault[0].options, false)
  })

  it('stops before metadata or vault access when the account guard rejects AUTH', async () => {
    const blocked = Object.assign(new Error('READ_ONLY_ACCOUNT'), { code: 'READ_ONLY_ACCOUNT' })
    const { provider, calls } = createProvider({
      guard: info => {
        calls.guard.push(info)
        throw blocked
      }
    })
    await assert.rejects(provider.signAuth({
      relay: 'wss://relay.example',
      challenge: 'challenge',
      pubkey: ALICE
    }), blocked)
    assert.equal(calls.metadata, 0)
    assert.equal(calls.vault.length, 0)
  })
})
