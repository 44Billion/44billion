import { ValidationError } from 'libp2r2p/error'

export const RELAY_AUTH_KIND = 22242
export const RELAY_AUTH_TIMEOUT_MS = 5000

export function createRelayAuthProvider ({
  canAuthenticate = () => true,
  signEvent,
  now = () => Math.floor(Date.now() / 1000)
} = {}) {
  if (typeof canAuthenticate !== 'function' || typeof signEvent !== 'function') {
    throw new ValidationError('INVALID_RELAY_AUTH_PROVIDER')
  }
  return {
    canAuthenticate,
    async signAuth ({ relay, challenge, pubkey } = {}) {
      if (typeof relay !== 'string' || !relay || typeof challenge !== 'string' || !challenge || typeof pubkey !== 'string' || !pubkey) {
        throw new ValidationError('INVALID_RELAY_AUTH_REQUEST')
      }
      return await signEvent({
        kind: RELAY_AUTH_KIND,
        created_at: now(),
        tags: [['relay', relay], ['challenge', challenge]],
        content: ''
      }, pubkey)
    }
  }
}

export function createVaultRelayAuthProvider ({
  askVault,
  timeoutMs = RELAY_AUTH_TIMEOUT_MS
} = {}) {
  if (typeof askVault !== 'function') throw new ValidationError('INVALID_VAULT_AUTH_TRANSPORT')
  return createRelayAuthProvider({
    canAuthenticate: pubkey => typeof pubkey === 'string' && /^[0-9a-f]{64}$/i.test(pubkey),
    signEvent: async (event, pubkey) => {
      const response = await askVault({
        code: 'NIP07',
        payload: {
          pubkey,
          ns: [''],
          method: 'sign_event',
          params: [event],
          context: 'relay-auth'
        }
      }, {
        timeout: timeoutMs,
        scheduling: { priority: true, chunk: false, archive: false }
      })
      if (response.error) throw response.error
      return response.payload
    }
  })
}
