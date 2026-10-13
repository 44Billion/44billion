import { base16ToBase62 } from 'libp2r2p/base62'

// Informational state only: operation authorization remains in the request path.
export function createSignerStateService ({ getStorage = () => globalThis.localStorage } = {}) {
  let connection = 'unknown'
  let accounts = new Map()
  let receivedAccounts = false
  const subscriptions = new Set()
  const capabilitySubscriptions = new Set()
  const denied = () => Object.assign(new Error('Pubkey is not part of the app active persona'), { code: 'PUBKEY_NOT_IN_PERSONA' })
  function read ({ pubkey, ownerPubkey, readKeys, readFlags }) {
    pubkey ??= ownerPubkey
    if (!/^[0-9a-f]{64}$/.test(pubkey || '') || (pubkey !== ownerPubkey && !readKeys().includes(pubkey))) throw denied()
    const flags = accounts.get(pubkey) || readFlags?.(pubkey)
    return {
      pubkey, connection, access: 'allowed',
      isLocked: connection === 'connected' && flags ? !!flags.isLocked : null,
      isReadOnly: connection === 'connected' && flags ? !!(flags.isReadOnly || flags.isDefaultUser) : null
    }
  }
  function deliver (entry) {
    let state
    try { state = read(entry.scope) } catch {
      state = { pubkey: entry.pubkey, connection: 'unknown', access: 'revoked', isLocked: null, isReadOnly: null }
      subscriptions.delete(entry)
    }
    const fingerprint = JSON.stringify(state)
    if (entry.fingerprint === fingerprint) return
    entry.fingerprint = fingerprint
    entry.notify(state)
  }
  function readContentKeyCapabilities ({ ownerPubkey, readKeys }) {
    return {
      ownerPubkey,
      pubkeysSupportingContentKeyMethods: [...new Set([ownerPubkey, ...readKeys()])]
        .filter(supportsContentKeyMethods)
        .sort()
    }
  }
  function supportsContentKeyMethods (pubkey) {
    if (!/^[0-9a-f]{64}$/.test(pubkey || '')) return false
    if (receivedAccounts) {
      const account = accounts.get(pubkey)
      if (!account) return false
      return typeof account.supportsContentKeyMethods === 'boolean'
        ? account.supportsContentKeyMethods
        : !account.isReadOnly
    }
    const storage = getStorage()
    if (!storage) return false
    // Match setAccountsState's encoding. The compatibility fallback is only
    // used for reading; an inferred capability is never persisted.
    const prefix = `session_accountByUserPk_${base16ToBase62(pubkey)}`
    const capability = storage.getItem(`${prefix}_supportsContentKeyMethods`)
    if (capability === 'true' || capability === 'false') return capability === 'true'
    return storage.getItem(`${prefix}_isReadOnly`) !== 'true'
  }
  function deliverCapabilities (entry) {
    const capabilities = readContentKeyCapabilities(entry.scope)
    const fingerprint = JSON.stringify(capabilities)
    if (entry.fingerprint === fingerprint) return
    entry.fingerprint = fingerprint
    entry.notify(capabilities)
  }
  function invalidate () {
    for (const entry of [...capabilitySubscriptions]) deliverCapabilities(entry)
    for (const entry of [...subscriptions]) deliver(entry)
  }
  return {
    read, invalidate, readContentKeyCapabilities,
    setConnection (value) { connection = value; invalidate() },
    setAccounts (values) {
      receivedAccounts = true
      accounts = new Map(values.map(({ pubkey, isLocked, isReadOnly, supportsContentKeyMethods }) => [pubkey, { isLocked, isReadOnly, supportsContentKeyMethods }]))
      invalidate()
    },
    subscribe (scope, notify) {
      const initial = read(scope)
      const entry = { scope, notify, pubkey: initial.pubkey }
      subscriptions.add(entry)
      deliver(entry)
      return () => subscriptions.delete(entry)
    },
    subscribeContentKeyCapabilities (scope, notify) {
      const entry = { scope, notify }
      capabilitySubscriptions.add(entry)
      deliverCapabilities(entry)
      return () => capabilitySubscriptions.delete(entry)
    }
  }
}

export const signerStates = createSignerStateService()
