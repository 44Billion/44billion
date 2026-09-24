import { startNostrDbAccountMaintenance } from '#services/nostrdb-account-lifecycle.js'
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
  useTask(({ cleanup }) => {
    cleanup(startNostrDbAccountMaintenance())
    cleanup(() => runtime.controller.abort())
  })
  useTask(({ track }) => {
    const accounts = track(() => {
      const defaultPk = storage.session_defaultUserPk$()
      return [...new Set(storage.session_accountUserPks$() ?? [])].filter(pk => pk !== defaultPk)
        .map(pk => ({ pk, isReadOnly: storage[`session_accountByUserPk_${pk}_isReadOnly$`]() === true }))
    })
    runtime.tracker.setAccounts(accounts.map(({ pk, isReadOnly }) => {
      const pubkey = base62ToBase16(pk, { mode: 'integer', byteLength: 32 })
      return {
        pubkey, isReadOnly,
        ...(isReadOnly ? {} : { getDb: () => getNostrDb(pubkey), coverage: createAccountEventCoverage(pubkey) }),
        getStoredEvent: kind => storage[`session_accountByUserPk_${pk}_${kind === 0 ? 'profile' : 'relays'}$`]?.()?.meta?.events?.find(event => event.kind === kind),
        sendToVault: event => tellVault({ code: 'UPDATE_ACCOUNT_EVENTS', payload: { pubkey, events: [event] } })
      }
    }))
  })
}
