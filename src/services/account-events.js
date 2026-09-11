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

// Seeds discover relay lists; only current write relays ingest other kinds.
// Removed write feeds stop receiving but finish processing accepted events.
export function trackAccountEvents ({ pubkey, signal, pool, seeds, db, getStoredEvent, sendToVault, reportError = console.error }) {
  const writes = new Map()
  let relayList = getStoredEvent(10002)
  const latest = new Map([0, 10002].map(kind => [kind, getStoredEvent(kind)]))
  function start (relay, discovery = false) {
    if (signal.aborted) return
    const entry = { relay, discovery, retired: new AbortController(), stream: null }
    if (!discovery) writes.set(relay, entry)
    maintain(entry).catch(error => { if (!signal.aborted) reportError(error) })
  }
  function reconcile (event) {
    const relays = new Set(writeRelays(event))
    for (const [relay, entry] of writes) {
      if (relays.has(relay)) continue
      writes.delete(relay)
      entry.retired.abort()
      entry.stream?.stopAndDrain()
    }
    for (const relay of relays) {
      if (!writes.has(relay)) start(relay)
    }
  }
  async function maintain (entry) {
    const stopped = AbortSignal.any([signal, entry.retired.signal])
    let delay = 1000
    while (!stopped.aborted) {
      try { await run(entry) } catch (error) { if (!signal.aborted) reportError(error) }
      if (stopped.aborted) return
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); stopped.removeEventListener('abort', finish); resolve() }
        const timer = setTimeout(finish, delay)
        timer.unref?.()
        stopped.addEventListener('abort', finish, { once: true })
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
  async function run (entry) {
    const filter = { authors: [pubkey], ...(entry.discovery ? { kinds: [10002] } : {}) }
    const stream = pool.getEventsFeedGenerator(filter, [entry.relay], { signal })
    entry.stream = stream
    try {
      for await (const event of stream) {
        if (signal.aborted) break
        if (entry.discovery && event.kind !== 10002) continue
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
          reconcile(event)
        }
        await persist(event)
      }
    } finally {
      entry.stream = null
    }
  }
  // Vault account metadata is already signed and can seed the local store
  // immediately, including when this device has no network connection.
  for (const event of latest.values()) {
    if (event?.pubkey === pubkey && !signal.aborted) persist(event)
  }
  for (const relay of new Set(seeds)) start(relay, true)
  reconcile(relayList)
}
