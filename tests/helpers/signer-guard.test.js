import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  guardSignerRequest,
  readSignerAccountFlags,
  READ_ONLY_ACCOUNT,
  READ_ONLY_TEMPORARY_ACCOUNT,
  VAULT_LOCKED
} from '../../src/helpers/window-message/browser/signer-guard.js'

function captureGuard ({ account = {} } = {}) {
  const attentionKinds = []
  const guard = (request = {}) => guardSignerRequest({
    ...request,
    account,
    onAttention: kind => attentionKinds.push(kind)
  })
  return { guard, attentionKinds }
}

function assertThrowsCode (fn, code) {
  assert.throws(fn, error => {
    assert.equal(error.message, code)
    assert.equal(error.code, code)
    return true
  })
}

describe('signer request guard', () => {
  it('always allows public-key reads for every account state', () => {
    for (const account of [
      { isDefaultUser: true },
      { isReadOnly: true },
      { isLocked: true },
      {}
    ]) {
      const { guard, attentionKinds } = captureGuard({ account })
      assert.doesNotThrow(() => guard({ method: 'get_public_key', params: [] }))
      assert.doesNotThrow(() => guard({ method: 'peek_public_key', params: [] }))
      assert.deepEqual(attentionKinds, [])
    }
  })

  it('lets unknown methods through so the vault keeps answering UNSUPPORTED_METHOD', () => {
    for (const account of [
      { isDefaultUser: true },
      { isReadOnly: true },
      { isLocked: true },
      {}
    ]) {
      const { guard, attentionKinds } = captureGuard({ account })
      assert.doesNotThrow(() => guard({ method: 'not_a_real_method', params: [] }))
      assert.deepEqual(attentionKinds, [])
    }
  })

  it('lets normal accounts through without errors or attention', () => {
    const { guard, attentionKinds } = captureGuard()
    for (const method of ['sign_event', 'double_sign_event', 'nip44v3_decrypt', 'nip04_encrypt', 'obfuscate', 'get_relays']) {
      assert.doesNotThrow(() => guard({ method, params: [{ kind: 1 }] }))
    }
    assert.deepEqual(attentionKinds, [])
  })

  it('blocks every signer method for the default user with READ_ONLY_TEMPORARY_ACCOUNT', () => {
    const { guard, attentionKinds } = captureGuard({ account: { isDefaultUser: true } })
    for (const method of ['sign_event', 'double_sign_event', 'nip04_encrypt', 'nip04_decrypt', 'nip44_encrypt', 'nip44_decrypt', 'nip44v3_encrypt', 'nip44v3_decrypt', 'nip44v3_encrypt_double_dh', 'nip44v3_decrypt_double_dh', 'nip44_encrypt_double_dh', 'nip44_decrypt_double_dh', 'obfuscate', 'get_relays']) {
      assertThrowsCode(() => guard({ method, params: [{ kind: 1 }] }), READ_ONLY_TEMPORARY_ACCOUNT)
    }
    // Signing (non-exempt kinds) is the only case that requests attention.
    assert.deepEqual(attentionKinds, ['create-account', 'create-account'])
  })

  it('does not request attention for AUTH/HTTP_AUTH/NWT signing', () => {
    for (const kind of [22242, 27235, 27519]) {
      const { guard, attentionKinds } = captureGuard({ account: { isDefaultUser: true } })
      assertThrowsCode(() => guard({ method: 'sign_event', params: [{ kind }] }), READ_ONLY_TEMPORARY_ACCOUNT)
      assert.deepEqual(attentionKinds, [])
    }
  })

  it('blocks signer methods for read-only accounts with READ_ONLY_ACCOUNT and no attention', () => {
    const { guard, attentionKinds } = captureGuard({ account: { isReadOnly: true } })
    assertThrowsCode(() => guard({ method: 'sign_event', params: [{ kind: 1 }] }), READ_ONLY_ACCOUNT)
    assertThrowsCode(() => guard({ method: 'double_sign_event', params: [{ kind: 1 }] }), READ_ONLY_ACCOUNT)
    assertThrowsCode(() => guard({ method: 'nip44v3_decrypt', params: [] }), READ_ONLY_ACCOUNT)
    assertThrowsCode(() => guard({ method: 'nip44v3_encrypt', params: [] }), READ_ONLY_ACCOUNT)
    assertThrowsCode(() => guard({ method: 'obfuscate', params: [] }), READ_ONLY_ACCOUNT)
    assertThrowsCode(() => guard({ method: 'get_relays', params: [] }), READ_ONLY_ACCOUNT)
    assert.deepEqual(attentionKinds, [])
  })

  it('blocks signer methods for locked accounts with VAULT_LOCKED', () => {
    const { guard, attentionKinds } = captureGuard({ account: { isLocked: true } })
    assertThrowsCode(() => guard({ method: 'sign_event', params: [{ kind: 1 }] }), VAULT_LOCKED)
    assertThrowsCode(() => guard({ method: 'nip44v3_decrypt', params: [] }), VAULT_LOCKED)
    assertThrowsCode(() => guard({ method: 'nip04_encrypt', params: [] }), VAULT_LOCKED)
    assertThrowsCode(() => guard({ method: 'obfuscate', params: [] }), VAULT_LOCKED)
    assert.deepEqual(attentionKinds, ['unlock-account'])
  })

  it('requests unlock attention only for non-exempt signing on locked accounts', () => {
    for (const kind of [22242, 27235, 27519]) {
      const { guard, attentionKinds } = captureGuard({ account: { isLocked: true } })
      assertThrowsCode(() => guard({ method: 'sign_event', params: [{ kind }] }), VAULT_LOCKED)
      assert.deepEqual(attentionKinds, [])
    }
  })

  it('reads account flags from storage, preferring read-only over locked', () => {
    const values = new Map([
      ['session_accountByUserPk_user_isReadOnly', 'true'],
      ['session_accountByUserPk_user_isLocked', 'true']
    ])
    const storage = {
      getItem: key => values.get(key) ?? null
    }

    assert.deepEqual(
      readSignerAccountFlags('user', { defaultUserPk: 'user', storage }),
      { isDefaultUser: true, isReadOnly: false, isLocked: false }
    )
    assert.deepEqual(
      readSignerAccountFlags('user', { defaultUserPk: 'other', storage }),
      { isDefaultUser: false, isReadOnly: true, isLocked: false }
    )

    values.set('session_accountByUserPk_user_isReadOnly', 'false')
    assert.deepEqual(
      readSignerAccountFlags('user', { defaultUserPk: 'other', storage }),
      { isDefaultUser: false, isReadOnly: false, isLocked: true }
    )

    values.set('session_accountByUserPk_user_isLocked', 'false')
    assert.deepEqual(
      readSignerAccountFlags('user', { defaultUserPk: 'other', storage }),
      { isDefaultUser: false, isReadOnly: false, isLocked: false }
    )
  })
})
