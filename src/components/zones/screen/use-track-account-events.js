import { useTask } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import nostrRelays, { seedRelays } from '#services/nostr-relays.js'
import { tellVault } from '#zones/vault-modal/index.js'
import { base62ToBase16 } from '#helpers/base62.js'
import { isValidRelayUrl } from '#helpers/relay.js'

// pk (base62) -> AbortController for all subscriptions related to that account
const activeSubscriptions = new Map()

export default function useTrackAccountEvents () {
  const storage = useWebStorage(localStorage)

  useTask(({ track }) => {
    const userPks = track(() => storage.session_accountUserPks$()) ?? []
    const defaultUserPk = storage.session_defaultUserPk$()

    // Only track real (post-VAULT_READY) accounts — skip the default placeholder user
    const realPks = userPks.filter(pk => pk !== defaultUserPk)
    const pkSet = new Set(realPks)

    // Stop tracking pubkeys that are no longer in account state
    for (const [pk, controller] of activeSubscriptions) {
      if (!pkSet.has(pk)) {
        controller.abort()
        activeSubscriptions.delete(pk)
      }
    }

    // Start tracking new pubkeys
    for (const pk of pkSet) {
      if (activeSubscriptions.has(pk)) continue
      const controller = new AbortController()
      activeSubscriptions.set(pk, controller)
      trackEventsForAccount(pk, controller.signal, storage)
    }
  })
}

function extractWriteRelays (event) {
  const relays = []
  for (const tag of event.tags ?? []) {
    if (tag[0] !== 'r' || typeof tag[1] !== 'string') continue
    const type = tag[2]
    if (type && type !== 'write') continue // skip read-only relays
    const url = tag[1].trim().replace(/\/+$/, '')
    if (isValidRelayUrl(url)) relays.push(url)
  }
  return relays
}

async function trackEventsForAccount (pk, signal, storage) {
  const pkBase16 = base62ToBase16(pk)

  const getStoredEventAt = (kind) => {
    if (kind === 0) {
      return storage[`session_accountByUserPk_${pk}_profile$`]()
        ?.meta?.events?.find(e => e.kind === 0)?.created_at ?? 0
    }
    if (kind === 10002) {
      return storage[`session_accountByUserPk_${pk}_relays$`]()
        ?.meta?.events?.find(e => e.kind === 10002)?.created_at ?? 0
    }
    return 0
  }

  const maybeSendToVault = (event) => {
    if (event.created_at <= getStoredEventAt(event.kind)) return
    tellVault({
      code: 'UPDATE_ACCOUNT_EVENTS',
      payload: { pubkey: pkBase16, events: [event] }
    })
  }

  // Stream kind 10002 (relay list) from seed relays — initial gap fill + live.
  // The first event tells us the user's write relays, which we use to start
  // a concurrent kind 0 (profile) stream on those relays.
  let kind0Started = false

  try {
    for await (const event of nostrRelays.getEventsFeedGenerator(
      { kinds: [10002], authors: [pkBase16], since: getStoredEventAt(10002), limit: 1 },
      seedRelays,
      { signal }
    )) {
      maybeSendToVault(event)

      if (!kind0Started) {
        kind0Started = true
        const writeRelays = extractWriteRelays(event)
        if (writeRelays.length > 0) {
          ;(async () => {
            for await (const e of nostrRelays.getEventsFeedGenerator(
              { kinds: [0], authors: [pkBase16], since: getStoredEventAt(0), limit: 1 },
              writeRelays,
              { signal }
            )) {
              maybeSendToVault(e)
            }
          })().catch(err => {
            if (!signal.aborted) console.error('Kind 0 tracking error for', pk, err)
          })
        }
      }
    }
  } catch (err) {
    if (!signal.aborted) console.error('Error tracking account events for', pk, err)
  }
}
