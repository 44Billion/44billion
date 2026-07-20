import { bytesToBase16 } from 'libp2r2p/base16'
import { base16ToBase62 } from 'libp2r2p/base62'

// bytesToBase62(base62ToBytes(base16ToBase62(Array(64).fill('f').join('')))).length === 43
// 'YHJSKWDa6oz1al1yMhwzwM8llg7hJNUca2J5RoW8xP1'
export function generateB62SecretKey () {
  return base16ToBase62(generateSecretKey(), { mode: 'integer', minLength: 43 })
}

function generateSecretKey () {
  const randomBytes = crypto.getRandomValues(new Uint8Array(40))
  const B256 = 2n ** 256n // secp256k1 is short weierstrass curve
  const N = B256 - 0x14551231950b75fc4402da1732fc9bebfn // curve (group) order
  const bytesToNumber = b => BigInt('0x' + (bytesToBase16(b) || '0'))
  const mod = (a, b) => { const r = a % b; return r >= 0n ? r : b + r } // mod division
  const num = mod(bytesToNumber(randomBytes), N - 1n) + 1n // takes at least n+8 bytes
  return num.toString(16).padStart(64, '0')
}
