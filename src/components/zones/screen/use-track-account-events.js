import { useMemo, useTask, useWebStorage } from '#f'
import { relayPool, seedRelays } from 'libp2r2p/relay'
import { base62ToBase16 } from 'libp2r2p/base62'
import { tellVault } from '#zones/vault-modal/index.js'
import { getNostrDb } from '#services/idb/nostrdb/index.js'
import { createAccountEventCoverage } from '#services/account-event-coverage.js'
import { createAccountEventTracker } from '#services/account-events.js'

export default function useTrackAccountEvents () {
  const storage = useWebStorage(localStorage)
  const runtime = useMemo(() => {
    const controller = new AbortController()
    const tracker = createAccountEventTracker({ pool: relayPool, seeds: seedRelays, signal: controller.signal })
    return { controller, tracker }
  })
  useTask(({ cleanup }) => cleanup(() => runtime.controller.abort()))
  useTask(({ track }) => {
    const { userPks, defaultPk } = track(() => ({
      userPks: storage.session_accountUserPks$() ?? [],
      defaultPk: storage.session_defaultUserPk$()
    }))
    const accounts = [...new Set(userPks.filter(pk => pk !== defaultPk))]
    runtime.tracker.setAccounts(accounts.map(pk => {
      const pubkey = base62ToBase16(pk, { mode: 'integer', byteLength: 32 })
      return {
        pubkey, db: getNostrDb(pubkey), coverage: createAccountEventCoverage(pubkey),
        getStoredEvent: kind => storage[`session_accountByUserPk_${pk}_${kind === 0 ? 'profile' : 'relays'}$`]?.()?.meta?.events?.find(event => event.kind === kind),
        sendToVault: event => tellVault({ code: 'UPDATE_ACCOUNT_EVENTS', payload: { pubkey, events: [event] } })
      }
    }))
  })
}
