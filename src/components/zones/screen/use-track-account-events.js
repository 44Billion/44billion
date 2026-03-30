import { useTask } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import nostrRelays, { seedRelays } from '#services/nostr-relays.js'
import { useRequestVaultMessage } from '#zones/vault-modal/index.js'
import { base62ToBase16 } from '#helpers/base62.js'
import { isValidRelayUrl } from '#helpers/relay.js'

// pk (base62) -> AbortController for all subscriptions related to that account
const activeSubscriptions = new Map()

export default function useTrackAccountEvents () {
  const storage = useWebStorage(localStorage)
  const vaultMsg = useRequestVaultMessage()

  useTask(({ track }) => {
    const userPks = track(() => storage.session_accountUserPks$()) ?? []
    const pkSet = new Set(userPks)

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
      trackEventsForAccount(pk, controller.signal, storage, vaultMsg)
    }
  })
}

async function trackEventsForAccount (pk, signal, storage, vaultMsg) {
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
    Promise.resolve(
      vaultMsg.postVaultMessage({
        code: 'UPDATE_ACCOUNT_EVENTS',
        payload: { pubkey: pkBase16, events: [event] }
      })
    ).catch(() => {})
  }

  const subscribeLive = (kinds, relays) => {
    ;(async () => {
      for await (const event of nostrRelays.getLiveEventsGenerator({ kinds, authors: [pkBase16] }, relays, { signal })) {
        maybeSendToVault(event)
      }
    })().catch(err => {
      if (!signal.aborted) console.error('Live subscription error:', err)
    })
  }

  try {
    const now = Math.floor(Date.now() / 1000)

    // --- kind 10002 (relay list) — always from seed relays ---

    // Start live subscription first so no events are missed
    subscribeLive([10002], seedRelays)

    // One-off fetch to get current relay list and write relays for kind 0
    const relayListResponse = await nostrRelays.getEventsAsap(
      { kinds: [10002], authors: [pkBase16], limit: 1, until: now },
      seedRelays,
      { signal }
    )
    if (signal.aborted) return

    const relayEvents = (relayListResponse.result ?? []).sort((a, b) => b.created_at - a.created_at)
    const latestRelayEvent = relayEvents[0]

    // Extract write relays from kind 10002 tags
    const writeRelays = []
    if (latestRelayEvent) {
      maybeSendToVault(latestRelayEvent)
      for (const tag of latestRelayEvent.tags ?? []) {
        if (tag[0] !== 'r' || typeof tag[1] !== 'string') continue
        const type = tag[2]
        if (type && type !== 'write') continue // skip read-only relays
        const url = tag[1].trim().replace(/\/+$/, '')
        if (isValidRelayUrl(url)) writeRelays.push(url)
      }
    }

    if (!writeRelays.length || signal.aborted) return

    // --- kind 0 (user metadata) — from write relays ---

    subscribeLive([0], writeRelays)

    const profileResponse = await nostrRelays.getEventsAsap(
      { kinds: [0], authors: [pkBase16], limit: 1, until: now },
      writeRelays,
      { signal }
    )
    if (signal.aborted) return

    const profileEvents = (profileResponse.result ?? []).sort((a, b) => b.created_at - a.created_at)
    const latestProfileEvent = profileEvents[0]
    if (latestProfileEvent) maybeSendToVault(latestProfileEvent)
  } catch (err) {
    if (!signal.aborted) console.error('Error tracking account events for', pk, err)
  }
}
