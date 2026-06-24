import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROAD_EVENT_KIND,
  EVENT_READ_PERMISSION,
  EVENT_WRITE_PERMISSION,
  ONE_TIME_DELETE_PERMISSION
} from '#helpers/window-message/browser/event-permissions.js'
import { needsNip07Permission, nip07PermissionContext } from '#helpers/window-message/browser/nip07-permission-context.js'

const PUBKEY = 'a'.repeat(64)

describe('NIP-07 permission context', () => {
  it('extracts NIP-44 v3 regular method kind and scope', () => {
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_encrypt', params: ['peer', '263', 'channel-pubkey', 'plain-b64'] }),
      {
        method: 'nip44v3Encrypt',
        eKind: 263,
        scope: 'channel-pubkey',
        permissions: [{ name: EVENT_WRITE_PERMISSION, eKind: 263 }]
      }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_decrypt', params: ['peer', 3560, '', 'ciphertext'] }),
      {
        method: 'nip44v3Decrypt',
        eKind: 3560,
        scope: '',
        permissions: [{ name: EVENT_READ_PERMISSION, eKind: 3560 }]
      }
    )
  })

  it('extracts NIP-44 v3 Double-DH wire method kind and scope', () => {
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_encrypt_double_dh', params: ['peer', '263', 'channel-pubkey', 'plain-b64', 'peer-content'] }),
      {
        method: 'nip44v3EncryptDoubleDH',
        eKind: 263,
        scope: 'channel-pubkey',
        permissions: [{ name: EVENT_WRITE_PERMISSION, eKind: 263 }]
      }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_decrypt_double_dh', params: ['peer', '3560', '', 'ciphertext', 'peer-content', 'own-content'] }),
      {
        method: 'nip44v3DecryptDoubleDH',
        eKind: 3560,
        scope: '',
        permissions: [{ name: EVENT_READ_PERMISSION, eKind: 3560 }]
      }
    )
  })

  it('does not remember invalid NIP-44 v3 kind permissions', () => {
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_encrypt', params: ['peer', 'not-a-kind', 'scope', 'plain-b64'] }),
      {
        method: 'nip44v3Encrypt',
        eKind: null,
        scope: 'scope',
        permissions: [{ name: EVENT_WRITE_PERMISSION, eKind: null, remember: false }]
      }
    )
  })

  it('uses broad remembered permissions for legacy encryption methods', () => {
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip04_encrypt', params: ['peer', 'plain'] }),
      {
        method: 'nip04Encrypt',
        eKind: BROAD_EVENT_KIND,
        permissions: [{ name: EVENT_WRITE_PERMISSION, eKind: BROAD_EVENT_KIND }]
      }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44_decrypt', params: ['peer', 'cipher'] }),
      {
        method: 'nip44Decrypt',
        eKind: BROAD_EVENT_KIND,
        permissions: [{ name: EVENT_READ_PERMISSION, eKind: BROAD_EVENT_KIND }]
      }
    )
  })

  it('treats public-key reads as permissionless', () => {
    assert.equal(needsNip07Permission('peek_public_key'), false)
    assert.equal(needsNip07Permission('peekPublicKey'), false)
    assert.equal(needsNip07Permission('get_public_key'), false)
    assert.equal(needsNip07Permission('getPublicKey'), false)
    assert.equal(needsNip07Permission('sign_event'), true)
  })

  it('maps sign, double-sign, and delete target permissions', () => {
    assert.deepEqual(
      nip07PermissionContext({ method: 'sign_event', params: [{ kind: 1 }] }),
      { method: 'signEvent', eKind: 1, permissions: [{ name: EVENT_WRITE_PERMISSION, eKind: 1 }] }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'double_sign_event', params: [{ kind: 30023 }] }),
      { method: 'doubleSignEvent', eKind: 30023, permissions: [{ name: EVENT_WRITE_PERMISSION, eKind: 30023 }] }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'sign_event', params: [{ kind: 5, tags: [['a', `1:${PUBKEY}:note`]] }] }),
      { method: 'signEvent', eKind: 5, permissions: [{ name: EVENT_WRITE_PERMISSION, eKind: 1 }] }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'sign_event', params: [{ kind: 5, tags: [['e', 'b'.repeat(64)]] }] }),
      { method: 'signEvent', eKind: 5, permissions: [{ name: ONE_TIME_DELETE_PERMISSION, eKind: 5, remember: false }] }
    )
  })
})
