// Informational state only: operation authorization remains in the request path.
export function createSignerStateService () {
  let connection = 'unknown'
  let accounts = new Map()
  const subscriptions = new Set()
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
  function invalidate () { for (const entry of [...subscriptions]) deliver(entry) }
  return {
    read, invalidate,
    setConnection (value) { connection = value; invalidate() },
    setAccounts (values) {
      accounts = new Map(values.map(({ pubkey, isLocked, isReadOnly }) => [pubkey, { isLocked, isReadOnly }]))
      invalidate()
    },
    subscribe (scope, notify) {
      const initial = read(scope)
      const entry = { scope, notify, pubkey: initial.pubkey }
      subscriptions.add(entry)
      deliver(entry)
      return () => subscriptions.delete(entry)
    }
  }
}

export const signerStates = createSignerStateService()
