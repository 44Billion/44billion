import { base16ToBase62 } from 'libp2r2p/base62'
import { appEncode } from 'libp2r2p/nip19'

import { createRelayAuthProvider } from '#services/relay-pool/auth.js'
import { guardSignerRequest, readSignerAccountFlags } from './browser/signer-guard.js'

export const APP_RELAY_AUTH_TIMEOUT_MS = 5000

export function createAppRelayAuthProvider ({
  appId,
  appAddress,
  appKey,
  wsKey,
  instanceUserPk,
  defaultUserPk,
  askVault,
  resolveAppMetadata,
  notifySignerRequestAttention = () => {},
  readPublicKeys,
  readAccountFlags = readSignerAccountFlags,
  guard = guardSignerRequest,
  timeoutMs = APP_RELAY_AUTH_TIMEOUT_MS
}) {
  const record = {
    instanceKey: appKey,
    appId,
    wsKey,
    instanceUserPk
  }
  return createRelayAuthProvider({
    canAuthenticate: pubkey => readPublicKeys(record)
      .some(candidate => candidate.toLowerCase() === pubkey.toLowerCase()),
    signEvent: async (event, pubkey) => {
      const accountUserPk = base16ToBase62(pubkey, { mode: 'integer', minLength: 43 })
      const account = readAccountFlags(accountUserPk, { defaultUserPk })
      guard({
        method: 'sign_event',
        params: [event],
        account,
        onAttention: kind => notifySignerRequestAttention({ kind, userPk: accountUserPk })
      })
      let app
      try {
        app = await resolveAppMetadata()
      } catch {
        app = {
          id: appId,
          napp: appEncode(appAddress),
          alias: appAddress?.dTag || undefined
        }
      }
      const { napp, ...appRest } = app
      const response = await askVault({
        code: 'NIP07',
        payload: {
          app: { ...appRest, id: napp },
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
