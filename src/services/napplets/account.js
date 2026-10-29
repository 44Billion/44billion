import { base62ToBase16 } from 'libp2r2p/base62'
import { verifyEvent, validateEvent } from 'nostr-tools/pure'
import { askNip07 } from '#helpers/window-message/browser/nip07.js'
import { readSignerAccountFlags, guardSignerRequest } from '#helpers/window-message/browser/signer-guard.js'
import { readAppPersonaContext, resolvePersonaUserPks } from '#services/personas/model.js'

export function createNappletAccount ({ appId, userPk, wsKey, name, signal, storage = globalThis.localStorage, askVault, requestPermission }) {
  const read = key => JSON.parse(storage.getItem(key) || 'null')
  const getPublicKey = () => {
    guard()
    if (userPk === read('session_defaultUserPk')) return null
    try { return base62ToBase16(userPk, { mode: 'integer', byteLength: 32 }).toLowerCase() } catch { return null }
  }
  function guard () {
    signal.throwIfAborted()
    if (wsKey && read(`session_workspaceByKey_${wsKey}_userPk`) !== userPk) throw new Error('ACCOUNT_ACCESS_REVOKED')
  }
  const guardIdentity = pubkey => {
    guard()
    if (!pubkey || pubkey !== getPublicKey()) throw new Error('ACCOUNT_ACCESS_REVOKED')
    if (wsKey && !resolvePersonaUserPks(readAppPersonaContext(read, { wsKey, appId, instanceUserPk: userPk })).includes(userPk)) throw new Error('ACCOUNT_ACCESS_REVOKED')
  }
  return {
    guard, getPublicKey,
    async signEvent (template) {
      const flags = readSignerAccountFlags(userPk, { defaultUserPk: read('session_defaultUserPk'), storage })
      guardSignerRequest({ method: 'sign_event', params: [template], account: flags })
      const pubkey = getPublicKey()
      guardIdentity(pubkey)
      const snapshot = structuredClone({ kind: template.kind, content: template.content, tags: template.tags, created_at: template.created_at })
      if (!validateEvent({ ...snapshot, pubkey })) throw new Error('INVALID_EVENT_TEMPLATE')
      if (!askVault || !requestPermission) throw new Error('SIGNER_UNAVAILABLE')
      const { payload, error } = await askNip07((message, options) => {
        guardIdentity(pubkey)
        // Recheck flags after any asynchronous permission dialog.
        const current = readSignerAccountFlags(userPk, { defaultUserPk: read('session_defaultUserPk'), storage })
        if (current.isDefaultUser || current.isReadOnly || current.isLocked) throw new Error(current.isLocked ? 'VAULT_LOCKED' : 'READ_ONLY_ACCOUNT')
        return askVault(message, options)
      }, pubkey, { method: 'sign_event', params: [snapshot] }, {
        ...flags, app: { id: appId, napp: appId, name },
        requestPermission: async request => { guardIdentity(pubkey); await requestPermission(request); guardIdentity(pubkey) }
      })
      guardIdentity(pubkey)
      if (error) throw Object.assign(new Error(error.message || error.code || String(error)), error)
      if (!payload || payload.pubkey !== pubkey || !verifyEvent(payload) || ['kind', 'content', 'created_at'].some(key => payload[key] !== snapshot[key]) || JSON.stringify(payload.tags) !== JSON.stringify(snapshot.tags)) throw new Error('INVALID_SIGNED_EVENT')
      return payload
    }
  }
}
