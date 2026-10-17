import assert from 'node:assert/strict'
import { test } from 'node:test'
import { serializeError as vaultSerialize } from '../../../ez-vault/src/helpers/error.js'
import { serializeError, reviveError } from '../../src/helpers/error.js'

test('vault-to-app errors preserve crypto codes and causes without serializing packets or secrets', () => {
  const cause = Object.assign(new Error('invalid MAC'), { code: 'INVALID_MAC', secretKey: 'secret', ciphertext: 'ciphertext', scope: 'private scope' })
  const error = Object.assign(new Error(cause.message, { cause }), { code: cause.code, stage: 'recipient-envelope', ownContentPubkey: 'public-key', hasOwnContentKey: true, packet: { content: 'secret payload' } })
  const vault = vaultSerialize(error)
  const bridge = serializeError(vault, vault.context)
  const restored = reviveError(bridge)
  assert.equal(restored.code, 'INVALID_MAC')
  assert.equal(restored.cause.code, 'INVALID_MAC')
  assert.equal(restored.stage, 'recipient-envelope')
  assert.equal(restored.ownContentPubkey, 'public-key')
  assert.equal(restored.hasOwnContentKey, true)
  assert.doesNotMatch(JSON.stringify(bridge), /secret payload|private scope|secretKey|ciphertext/)
  cause.cause = cause
  assert.doesNotThrow(() => JSON.stringify(vaultSerialize(error)))
})
