import { ValidationError } from 'libp2r2p/error'

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const encryptMethods = new Set(['nip44v3_encrypt', 'nip44v3_encrypt_double_dh'])
const decryptMethods = new Set(['nip44v3_decrypt', 'nip44v3_decrypt_double_dh'])

function plaintextBytes (value) {
  try {
    // A native brand check accepts cross-realm ArrayBuffers, but not views,
    // SharedArrayBuffers or objects spoofing Symbol.toStringTag.
    arrayBufferByteLength.call(value)
    return new Uint8Array(value)
  } catch (cause) {
    throw new ValidationError('INVALID_PLAINTEXT_BUFFER', { message: 'Plaintext must be an attached ArrayBuffer.', cause })
  }
}

// Both the app API and the local vault channel carry binary plaintext.
// All identity/namespace variants must use this same boundary.
export function createNip07Method ({ method, context, connection, ask, timeout = 5 * 60 * 1000 }) {
  return async (...params) => {
    // Snapshot bytes before waiting for the handshake or permission UI.
    if (encryptMethods.has(method)) params[3] = plaintextBytes(params[3]).slice().buffer
    const port = await connection
    const { payload, error } = await ask(port, {
      code: 'NIP07', payload: { ...context, method, params }
    }, { timeout })
    if (error) throw error
    if (decryptMethods.has(method)) plaintextBytes(payload)
    return payload
  }
}
