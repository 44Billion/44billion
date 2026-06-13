import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { needsNip07Permission, nip07PermissionContext } from '#helpers/window-message/browser/nip07-permission-context.js'

describe('NIP-07 permission context', () => {
  it('extracts NIP-44 v3 regular method kind and scope', () => {
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_encrypt', params: ['peer', '263', 'channel-pubkey', 'plain-b64'] }),
      { method: 'nip44v3Encrypt', eKind: 263, scope: 'channel-pubkey' }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_decrypt', params: ['peer', 3560, '', 'ciphertext'] }),
      { method: 'nip44v3Decrypt', eKind: 3560, scope: '' }
    )
  })

  it('extracts NIP-44 v3 Double-DH wire method kind and scope', () => {
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_encrypt_double_dh', params: ['peer', '263', 'channel-pubkey', 'plain-b64', 'peer-content'] }),
      { method: 'nip44v3EncryptDoubleDH', eKind: 263, scope: 'channel-pubkey' }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_decrypt_double_dh', params: ['peer', '3560', '', 'ciphertext', 'peer-content', 'own-content'] }),
      { method: 'nip44v3DecryptDoubleDH', eKind: 3560, scope: '' }
    )
  })

  it('does not remember invalid NIP-44 v3 kind permissions', () => {
    assert.deepEqual(
      nip07PermissionContext({ method: 'nip44v3_encrypt', params: ['peer', 'not-a-kind', 'scope', 'plain-b64'] }),
      { method: 'nip44v3Encrypt', eKind: null, scope: 'scope' }
    )
  })

  it('treats public-key reads as permissionless', () => {
    assert.equal(needsNip07Permission('peek_public_key'), false)
    assert.equal(needsNip07Permission('peekPublicKey'), false)
    assert.equal(needsNip07Permission('get_public_key'), false)
    assert.equal(needsNip07Permission('getPublicKey'), false)
    assert.equal(needsNip07Permission('sign_event'), true)
  })

  it('keeps sign and double-sign event-kind behavior', () => {
    assert.deepEqual(
      nip07PermissionContext({ method: 'sign_event', params: [{ kind: 1 }] }),
      { method: 'signEvent', eKind: 1 }
    )
    assert.deepEqual(
      nip07PermissionContext({ method: 'double_sign_event', params: [{ kind: 30023 }] }),
      { method: 'doubleSignEvent', eKind: 30023 }
    )
  })
})
