import { useMemo, useTask, useWebStorage } from '#f'
import { relayPool, seedRelays } from 'libp2r2p/relay'
import { base62ToBase16 } from 'libp2r2p/base62'
import { tellVault } from '#zones/vault-modal/index.js'
import { getNostrDb } from '#services/idb/nostrdb/index.js'
import { trackAccountEvents } from '#services/account-events.js'

export default function useTrackAccountEvents () {
  const storage = useWebStorage(localStorage)
  const active = useMemo(() => new Map())
  useTask(({ cleanup }) => cleanup(() => {
    for (const controller of active.values()) controller.abort()
    active.clear()
  }))
  useTask(({ track }) => {
    const { userPks, defaultPk } = track(() => ({
      userPks: storage.session_accountUserPks$() ?? [],
      defaultPk: storage.session_defaultUserPk$()
    }))
    const accounts = new Set(userPks.filter(pk => pk !== defaultPk))
    for (const [pk, controller] of active) {
      if (!accounts.has(pk)) { controller.abort(); active.delete(pk) }
    }
    for (const pk of accounts) {
      if (active.has(pk)) continue
      const controller = new AbortController()
      active.set(pk, controller)
      const pubkey = base62ToBase16(pk, { mode: 'integer', byteLength: 32 })
      trackAccountEvents({
        pubkey, signal: controller.signal, pool: relayPool, seeds: seedRelays,
        db: getNostrDb(pubkey),
        getStoredEvent: kind => storage[`session_accountByUserPk_${pk}_${kind === 0 ? 'profile' : 'relays'}$`]()?.meta?.events?.find(event => event.kind === kind),
        sendToVault: event => tellVault({ code: 'UPDATE_ACCOUNT_EVENTS', payload: { pubkey, events: [event] } })
      })
    }
  })
}
