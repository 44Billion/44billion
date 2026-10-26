import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROAD_EVENT_KIND,
  EVENT_ACCESS_PERMISSION,
  EVENT_ACCESS_PERSONAL_PERMISSION,
  LEGACY_CRYPTO_ACCESS_PERMISSION,
  ONE_TIME_DELETE_PERMISSION
} from '#helpers/window-message/browser/event-permissions.js'
import { createPermissionScopeRegistry } from '#helpers/window-message/browser/permission-scopes.js'
import { needsNip07Permission, nip07PermissionContext } from '#helpers/window-message/browser/nip07-permission-context.js'
import { askNip07 } from '#helpers/window-message/browser/nip07.js'

const PUBKEY = 'a'.repeat(64)

describe('NIP-07 permission context', () => {
  it('extracts NIP-44 v3 regular method kind and scope', () => {
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_encrypt', params: ['peer', '26300', 'channel-pubkey', 'plain-b64'] }),
      {
        method: 'nip44v3Encrypt',
        eKind: 26300,
        scope: '',
        permissions: []
      }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_decrypt', params: ['peer', 3560, '', 'ciphertext'] }),
      {
        method: 'nip44v3Decrypt',
        eKind: 3560,
        scope: '',
        permissions: []
      }
    )
  })

  it('extracts NIP-44 v3 Double-DH wire method kind and scope', () => {
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_encrypt_double_dh', params: ['peer', '26300', 'channel-pubkey', 'plain-b64', 'peer-content'] }),
      {
        method: 'nip44v3EncryptDoubleDH',
        eKind: 26300,
        scope: '',
        permissions: []
      }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_decrypt_double_dh', params: ['peer', '3560', '', 'ciphertext', 'peer-content', 'own-content'] }),
      {
        method: 'nip44v3DecryptDoubleDH',
        eKind: 3560,
        scope: '',
        permissions: []
      }
    )
  })

  it('rejects invalid NIP-44 v3 kinds before requesting permission', () => {
    assert.throws(
      () => nip07PermissionContext({ method: 'nip44v3_encrypt', params: ['peer', 'not-a-kind', 'scope', 'plain-b64'] }),
      error => error.code === 'INVALID_KIND'
    )
    assert.throws(
      () => nip07PermissionContext({ method: 'nip44v3_decrypt', params: ['peer', 65536, '', 'ciphertext'] }),
      error => error.code === 'INVALID_KIND'
    )
  })

  it('uses personal permissions for raw NIP-44 v3 non-transport kinds', () => {
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_decrypt', params: ['peer', 2567, '', 'ciphertext'] }),
      {
        method: 'nip44v3Decrypt',
        eKind: 2567,
        scope: '',
        permissions: [{ name: EVENT_ACCESS_PERSONAL_PERMISSION, eKind: 2567, scope: '' }]
      }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_decrypt', params: ['peer', 1006, '', 'ciphertext'] }),
      {
        method: 'nip44v3Decrypt',
        eKind: 1006,
        scope: '',
        permissions: [{ name: EVENT_ACCESS_PERSONAL_PERMISSION, eKind: 1006, scope: '' }]
      }
    )
  })

  it('uses kind-specific registry entries and maps unknown scopes to kind-wide access', () => {
    const scopeRegistry = createPermissionScopeRegistry([
      { kind: 9, scope: 'calendar:v1', labelKey: 'calendar sync' },
      { kind: 1063, scope: 'calendar:v1', labelKey: 'file calendar sync' }
    ])
    assert.deepEqual(
      nip07PermissionContext({
        method: 'nip44v3_encrypt',
        params: ['peer', 9, 'calendar:v1', 'plain-b64'],
        scopeRegistry
      }),
      {
        method: 'nip44v3Encrypt',
        eKind: 9,
        scope: 'calendar:v1',
        permissions: [{
          name: EVENT_ACCESS_PERSONAL_PERMISSION,
          eKind: 9,
          scope: 'calendar:v1',
          scopeLabelKey: 'calendar sync'
        }]
      }
    )
    assert.deepEqual(
      nip07PermissionContext({
        method: 'nip44v3_decrypt',
        params: ['peer', 9, 'zillion:conversation-summaries:v1', 'ciphertext'],
        scopeRegistry
      }),
      {
        method: 'nip44v3Decrypt',
        eKind: 9,
        scope: '',
        permissions: [{ name: EVENT_ACCESS_PERSONAL_PERMISSION, eKind: 9, scope: '' }]
      }
    )
    assert.throws(
      () => nip07PermissionContext({ method: 'nip44v3_encrypt', params: ['peer', 9, 1, 'plain-b64'] }),
      error => error.code === 'INVALID_SCOPE'
    )
  })

  it('uses a dedicated remembered permission for legacy encryption methods', () => {
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip04_encrypt', params: ['peer', 'plain'] }),
      {
        method: 'nip04Encrypt',
        eKind: BROAD_EVENT_KIND,
        permissions: [{ name: LEGACY_CRYPTO_ACCESS_PERMISSION, eKind: BROAD_EVENT_KIND, scope: '' }]
      }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44_decrypt', params: ['peer', 'cipher'] }),
      {
        method: 'nip44Decrypt',
        eKind: BROAD_EVENT_KIND,
        permissions: [{ name: LEGACY_CRYPTO_ACCESS_PERMISSION, eKind: BROAD_EVENT_KIND, scope: '' }]
      }
    )
  })

  it('treats public-key reads as permissionless', () => {
    assert.equal(needsNip07Permission('peek_public_key'), false)
    assert.equal(needsNip07Permission('peekPublicKey'), false)
    assert.equal(needsNip07Permission('get_public_key'), false)
    assert.equal(needsNip07Permission('getPublicKey'), false)
    assert.equal(needsNip07Permission('obfuscate'), false)
    assert.equal(needsNip07Permission('sign_event'), true)
  })

  it('maps sign, double-sign, and delete target permissions', () => {
    assert.deepEqual(
      nip07PermissionContext({ method: 'sign_event', params: [{ kind: 1 }] }),
      { method: 'signEvent', eKind: 1, permissions: [{ name: EVENT_ACCESS_PERMISSION, eKind: 1, scope: '' }] }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'double_sign_event', params: [{ kind: 30023 }] }),
      { method: 'doubleSignEvent', eKind: 30023, permissions: [{ name: EVENT_ACCESS_PERMISSION, eKind: 30023, scope: '' }] }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'sign_event', params: [{ kind: 5, tags: [['a', `1:${PUBKEY}:note`]] }] }),
      { method: 'signEvent', eKind: 5, permissions: [{ name: EVENT_ACCESS_PERMISSION, eKind: 1, scope: '' }] }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'sign_event', params: [{ kind: 5, tags: [['e', 'b'.repeat(64)]] }] }),
      { method: 'signEvent', eKind: 5, permissions: [{ name: ONE_TIME_DELETE_PERMISSION, eKind: 5, remember: false, scope: '' }] }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'sign_event', params: [{ kind: 26300, tags: [] }] }),
      { method: 'signEvent', eKind: 26300, permissions: [] }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'sign_event', params: [{ kind: 2, tags: [] }] }),
      { method: 'signEvent', eKind: 2, permissions: [{ name: EVENT_ACCESS_PERMISSION, eKind: 2, scope: '' }] }
    )
    for (const kind of [3560, 1006]) {
      assert.deepEqual(
        nip07PermissionContext({ method: 'sign_event', params: [{ kind, tags: [] }] }),
        { method: 'signEvent', eKind: kind, permissions: [] }
      )
    }
    assert.deepEqual(
      nip07PermissionContext({ method: 'sign_event', params: [{ kind: 5, tags: [['a', `3560:${PUBKEY}:`]] }] }),
      { method: 'signEvent', eKind: 5, permissions: [{ name: EVENT_ACCESS_PERMISSION, eKind: 3560, scope: '' }] }
    )
  })

  it('passes resolved scope separately and never exposes an unknown raw scope to the prompt', async () => {
    const requests = []
    const params = ['b'.repeat(64), 9, 'zillion:conversation-summaries:v1', 'ciphertext']
    await askNip07(async () => ({ payload: 'plaintext' }), PUBKEY, {
      method: 'nip44v3_decrypt',
      params
    }, {
      app: { id: 'app', napp: 'zillion' },
      requestPermission: async request => requests.push(request)
    })

    assert.equal(requests.length, 1)
    assert.equal(requests[0].scope, '')
    assert.equal(requests[0].eKind, 9)
    assert.deepEqual(requests[0].meta.params, params)
    assert.equal(Object.hasOwn(requests[0].meta, 'scope'), false)
    assert.equal(Object.hasOwn(requests[0].meta, 'scopeLabelKey'), false)
  })
})
