import { isEphemeralEvent } from 'libp2r2p/event'
import { CUSTOM_APP_DATA, REGULAR_CUSTOM_APP_DATA } from 'libp2r2p/kind'
import { isValidPublicRelayUrl, normalizeRelayUrl } from 'libp2r2p/url'

export function shouldStoreAccountEvent (event) {
  return event.kind !== CUSTOM_APP_DATA && event.kind !== REGULAR_CUSTOM_APP_DATA && !isEphemeralEvent(event)
}

function writeRelays (event) {
  return (event?.tags ?? []).flatMap(tag => {
    if (tag[0] !== 'r' || (tag[2] && tag[2] !== 'write')) return []
    try {
      const url = normalizeRelayUrl(tag[1])
      return isValidPublicRelayUrl(url) ? [url] : []
    } catch { return [] }
  })
}

// Each discovered write relay gets a historical and live feed. Relay-list
// updates expand coverage without interrupting the existing feeds.
export function trackAccountEvents ({ pubkey, signal, pool, seeds, db, getStoredEvent, sendToVault, reportError = console.error }) {
  const started = new Set()
  let relayList = getStoredEvent(10002)
  const latest = new Map([0, 10002].map(kind => [kind, getStoredEvent(kind)]))
  function start (relays) {
    for (const relay of relays) {
      if (signal.aborted || started.has(relay)) continue
      started.add(relay)
      maintain(relay).catch(error => { if (!signal.aborted) reportError(error) })
    }
  }
  async function maintain (relay) {
    let delay = 1000
    while (!signal.aborted) {
      try { await run(relay) } catch (error) { if (!signal.aborted) reportError(error) }
      if (signal.aborted) return
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
        const timer = setTimeout(finish, delay)
        timer.unref?.()
        signal.addEventListener('abort', finish, { once: true })
      })
      delay = Math.min(delay * 2, 30000)
    }
  }
  async function persist (event) {
    try {
      const result = await db.add(event)
      if (!result.ok) reportError(new Error(`Account event storage failed: ${result.code}`))
    } catch (error) { if (!signal.aborted) reportError(error) }
  }
  async function run (relay) {
    for await (const event of pool.getEventsFeedGenerator({ authors: [pubkey] }, [relay], { signal })) {
      if (signal.aborted) break
      if (event.pubkey !== pubkey || !shouldStoreAccountEvent(event)) continue
      if (event.kind === 0 || event.kind === 10002) {
        const previous = latest.get(event.kind)
        if (!previous || event.created_at > previous.created_at || (event.created_at === previous.created_at && event.id < previous.id)) {
          latest.set(event.kind, event)
          sendToVault(event)
        }
      }
      if (event.kind === 10002 && (!relayList || event.created_at > relayList.created_at || (event.created_at === relayList.created_at && event.id < relayList.id))) {
        relayList = event
        start(writeRelays(event))
      }
      await persist(event)
    }
  }
  // Vault account metadata is already signed and can seed the local store
  // immediately, including when this device has no network connection.
  for (const event of latest.values()) {
    if (event?.pubkey === pubkey && !signal.aborted) persist(event)
  }
  start([...seeds, ...writeRelays(relayList)])
}
