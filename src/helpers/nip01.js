import { bytesToBase16 } from '#helpers/base16.js'
import { base16ToBase62 } from '#helpers/base62.js'
import { base16ToBase36 } from '#helpers/base36.js'

// bytesToBase62(base62ToBytes(base16ToBase62(Array(64).fill('f').join('')))).length === 43
// 'YHJSKWDa6oz1al1yMhwzwM8llg7hJNUca2J5RoW8xP1'
// bytesToBase64(base64ToBytes(base16ToBase64(Array(64).fill('f').join('')))).length === 43
// '__________________________________________8'
export function generateB62SecretKey () {
  return base16ToBase62(generateSecretKey(), 43)
}

// bytesToBase36(base36ToBytes(base16ToBase36(Array(64).fill('f').join('')))).length
// '6dp5qcb22im238nr3wvp0ic7q99w035jmy2iw7i6n43d37jtof'
// subdomain safe
export function generateB36SecretKey () {
  return base16ToBase36(generateSecretKey(), 50)
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
