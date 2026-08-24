import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { toTestSignal } from './signal-mock.js'

mock.module('#f', {
  namedExports: {
    toSignal: toTestSignal
  }
})

const {
  clearSignerRequestAttention,
  isActiveWorkspaceUser,
  requestSignerAttention,
  signerRequestAttention$,
  SIGNER_REQUEST_ATTENTION_MS
} = await import('../../src/helpers/signer-request-attention.js')

describe('signer request attention', () => {
  it('opens once and coalesces repeated requests for the same kind and user', () => {
    clearSignerRequestAttention()
    assert.equal(requestSignerAttention({ kind: 'create-account', userPk: 'user' }), true)
    const first = signerRequestAttention$()
    assert.equal(first.kind, 'create-account')
    assert.equal(first.userPk, 'user')
    assert.equal(first.expiresAt > Date.now(), true)

    assert.equal(requestSignerAttention({ kind: 'create-account', userPk: 'user' }), false)
    assert.equal(signerRequestAttention$().id, first.id)
    assert.equal(signerRequestAttention$().expiresAt, first.expiresAt)
  })

  it('reopens for a different kind, user, or after the window expires', () => {
    clearSignerRequestAttention()
    assert.equal(requestSignerAttention({ kind: 'create-account', userPk: 'user' }), true)

    assert.equal(requestSignerAttention({ kind: 'unlock-account', userPk: 'user' }), true)
    assert.equal(signerRequestAttention$().kind, 'unlock-account')

    assert.equal(requestSignerAttention({ kind: 'create-account', userPk: 'other' }), true)
    assert.equal(signerRequestAttention$().userPk, 'other')

    signerRequestAttention$({
      id: 0,
      kind: 'create-account',
      userPk: 'other',
      expiresAt: Date.now() - 1
    })
    assert.equal(requestSignerAttention({ kind: 'create-account', userPk: 'other' }), true)
  })

  it('clears explicitly and allows reopening immediately', () => {
    clearSignerRequestAttention()
    assert.equal(requestSignerAttention({ kind: 'unlock-account', userPk: 'user' }), true)
    clearSignerRequestAttention()
    assert.equal(signerRequestAttention$(), null)
    assert.equal(requestSignerAttention({ kind: 'unlock-account', userPk: 'user' }), true)
  })

  it('keeps a sane attention window', () => {
    assert.equal(SIGNER_REQUEST_ATTENTION_MS, 6000)
  })

  it('detects the active workspace user from JSON-serialized storage', () => {
    const values = new Map([
      ['session_openWorkspaceKeys', JSON.stringify(['ws-1'])],
      ['session_workspaceByKey_ws-1_userPk', JSON.stringify('user-a')]
    ])
    const storage = {
      getItem: key => values.get(key) ?? null
    }

    assert.equal(isActiveWorkspaceUser('user-a', storage), true)
    assert.equal(isActiveWorkspaceUser('user-b', storage), false)
    assert.equal(isActiveWorkspaceUser('user-a', { getItem: () => null }), false)
    assert.equal(isActiveWorkspaceUser('user-a', { getItem: () => '{invalid' }), false)
  })
})
