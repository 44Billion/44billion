import { bytesToBase62 } from 'libp2r2p/base62'
import { generateSecretKey } from 'libp2r2p/key'

// bytesToBase62(base62ToBytes(base16ToBase62(Array(64).fill('f').join('')))).length === 43
// 'YHJSKWDa6oz1al1yMhwzwM8llg7hJNUca2J5RoW8xP1'
export function generateB62SecretKey () {
  return bytesToBase62(generateSecretKey(), { mode: 'integer', minLength: 43 })
}
