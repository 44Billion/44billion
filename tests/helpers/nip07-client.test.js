import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { createNip07Method } from '../../src/helpers/window-message/nip07-client.js'
import { bytesToBase64 } from 'libp2r2p/base64'
import { getPublicKey } from 'libp2r2p/key'
import { encryptBytes, decryptBytes } from 'libp2r2p/nip44-v3'

test('NIP-07 ArrayBuffers round-trip through the real local byte codec', async () => {
  const secret = new Uint8Array(32).fill(1)
  const pubkey = getPublicKey(secret)
  const context = { ns: ['notes'], userPk: pubkey, with_shared_key: ['peer', 'scope'] }
  const ask = async (port, message) => {
    assert.equal(port, 'port')
    const { method, params, ...receivedContext } = message.payload
    assert.deepEqual(receivedContext, context)
    const [peer, kind, scope, payload] = params
    const scopeBytes = new TextEncoder().encode(scope)
    return {
      payload: method === 'nip44v3_encrypt'
        ? encryptBytes(secret, peer, kind, scopeBytes, new Uint8Array(payload))
        : decryptBytes(secret, peer, kind, scopeBytes, payload).slice().buffer
    }
  }
  const encrypt = createNip07Method({ method: 'nip44v3_encrypt', context, connection: Promise.resolve('port'), ask })
  const decrypt = createNip07Method({ method: 'nip44v3_decrypt', context, connection: Promise.resolve('port'), ask })
  for (const bytes of [new Uint8Array(), new Uint8Array([0, 255, 251, 128]), new TextEncoder().encode('https://tabler.io/icons?icon=server-bolt 😀 ação')]) {
    const ciphertext = await encrypt(pubkey, 9, '', bytes.buffer)
    const plaintext = await decrypt(pubkey, 9, '', ciphertext)
    assert.ok(plaintext instanceof ArrayBuffer)
    assert.deepEqual(new Uint8Array(plaintext), bytes)
    assert.equal(bytes.byteLength, bytes.buffer.byteLength, 'caller buffer remains attached')
  }
})

test('both v3 variants snapshot cross-realm buffers before the handshake', async () => {
  for (const method of ['nip44v3_encrypt', 'nip44v3_encrypt_double_dh']) {
    const connection = Promise.withResolvers()
    const buffer = runInNewContext('new Uint8Array([251, 255, 0]).buffer')
    const reply = method.endsWith('double_dh') ? ['ciphertext', 'content-pubkey'] : 'ciphertext'
    const encrypt = createNip07Method({
      method, connection: connection.promise, context: {}, ask: async (port, { payload }) => {
        assert.ok(payload.params[3] instanceof ArrayBuffer)
        assert.deepEqual(new Uint8Array(payload.params[3]), new Uint8Array([251, 255, 0]))
        assert.deepEqual(payload.params.slice(4), ['peer-content'])
        return { payload: reply }
      }
    })
    const result = encrypt('peer', 9, '', buffer, 'peer-content')
    new Uint8Array(buffer).fill(0)
    connection.resolve('port')
    assert.deepEqual(await result, reply)
  }
})

test('invalid binary plaintext never reaches permission or transport', async () => {
  const detached = new ArrayBuffer(1)
  structuredClone(detached, { transfer: [detached] })
  for (const method of ['nip44v3_encrypt', 'nip44v3_encrypt_double_dh']) {
    const encrypt = createNip07Method({ method, connection: Promise.resolve('port'), ask: () => assert.fail('must not ask') })
    for (const value of ['+/8A', 'text', undefined, null, new Uint8Array(2), new DataView(new ArrayBuffer(2)), new SharedArrayBuffer(2), detached, { [Symbol.toStringTag]: 'ArrayBuffer' }]) {
      await assert.rejects(encrypt('peer', 9, '', value), { code: 'INVALID_PLAINTEXT_BUFFER' })
    }
  }
})

test('Double DH decrypt returns bytes and preserves key selection and errors', async () => {
  const params = ['peer', 9, '', 'ciphertext', 'peer-content', 'own-content']
  const make = reply => createNip07Method({
    method: 'nip44v3_decrypt_double_dh', connection: Promise.resolve('port'), ask: async (port, message) => {
      assert.deepEqual(message.payload.params, params)
      return reply
    }
  })
  assert.deepEqual(new Uint8Array(await make({ payload: new Uint8Array([251, 255, 0]).buffer })(...params)), new Uint8Array([251, 255, 0]))
  await assert.rejects(make({ payload: '-_8A' })(...params), { code: 'INVALID_PLAINTEXT_BUFFER' })
  const error = new Error('Permission denied')
  await assert.rejects(make({ error })(...params), value => value === error)
})

test('other signer methods keep their text, event and error contracts', async () => {
  for (const method of ['nip04_encrypt', 'nip04_decrypt', 'nip44_encrypt', 'nip44_decrypt', 'sign_event', 'double_sign_event', 'obfuscate']) {
    const params = ['peer', 'https://tabler.io/icons?icon=server-bolt 😀']
    const call = createNip07Method({
      method, connection: Promise.resolve('port'), ask: async (port, message) => {
        assert.deepEqual(message.payload.params, params)
        return { payload: bytesToBase64(new Uint8Array([251, 255])) }
      }
    })
    assert.equal(await call(...params), '+/8=')
  }
})
