import { isEphemeralEvent } from 'libp2r2p/event'
import {
  eventKinds, isEphemeralKind,
  CUSTOM_APP_DATA, REGULAR_CUSTOM_APP_DATA, PERSONAL_COPY,
  GIFT_WRAP, PRIVATE_DIRECT_MESSAGE, SEAL, ENCRYPTED_DIRECT_MESSAGE,
  PRIVATE_CHANNEL_BROADCAST, MUTE_LIST, BOOKMARKS, BOOKMARK_SET,
  KIND_MUTE_SET, DRAFT_LONG, DRAFT_CLASSIFIED_LISTING, BINARY_DATA_CHUNK
} from 'libp2r2p/kind'
import { isValidPublicRelayUrl, normalizeRelayUrl } from 'libp2r2p/url'

// These belong to app/private-message/file flows, not automatic account import.
const excludedKinds = new Set([
  CUSTOM_APP_DATA, REGULAR_CUSTOM_APP_DATA, PERSONAL_COPY,
  GIFT_WRAP, PRIVATE_DIRECT_MESSAGE, SEAL, ENCRYPTED_DIRECT_MESSAGE,
  PRIVATE_CHANNEL_BROADCAST, MUTE_LIST, BOOKMARKS, BOOKMARK_SET,
  KIND_MUTE_SET, DRAFT_LONG, DRAFT_CLASSIFIED_LISTING, BINARY_DATA_CHUNK
])
const accountKinds = [...new Set(Object.values(eventKinds))]
  .filter(kind => !isEphemeralKind(kind) && !excludedKinds.has(kind))
  .sort((a, b) => a - b)
const allowedKinds = new Set(accountKinds)
// 44b-relay silently truncates longer lists. Deduplicate before splitting.
const MAX_KINDS_PER_FILTER = 30
const kindGroups = Array.from({ length: Math.ceil(accountKinds.length / MAX_KINDS_PER_FILTER) }, (_, index) =>
  accountKinds.slice(index * MAX_KINDS_PER_FILTER, (index + 1) * MAX_KINDS_PER_FILTER))

export function shouldStoreAccountEvent (event) {
  return allowedKinds.has(event.kind) && !isEphemeralEvent(event)
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
    const entry = { relay, retired: new AbortController(), streams: new Set() }
    if (!discovery) writes.set(relay, entry)
    for (const kinds of discovery ? [[10002]] : kindGroups) {
      maintain(entry, kinds).catch(error => { if (!signal.aborted) reportError(error, { relay: entry.relay }) })
    }
  }
  function reconcile (event) {
    const relays = new Set(writeRelays(event))
    for (const [relay, entry] of writes) {
      if (relays.has(relay)) continue
      writes.delete(relay)
      entry.retired.abort()
      for (const stream of entry.streams) stream.stopAndDrain()
    }
    for (const relay of relays) {
      if (!writes.has(relay)) start(relay)
    }
  }
  async function maintain (entry, kinds) {
    const stopped = AbortSignal.any([signal, entry.retired.signal])
    let delay = 1000
    while (!stopped.aborted) {
      try { await run(entry, kinds) } catch (error) { if (!signal.aborted) reportError(error, { relay: entry.relay }) }
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
  async function run (entry, kinds) {
    const filter = { authors: [pubkey], kinds: [...kinds] }
    const stream = pool.getEventsFeedGenerator(filter, [entry.relay], { signal })
    entry.streams.add(stream)
    try {
      for await (const item of stream) {
        if (item.type === 'error') { reportError(item.error, { relay: item.relay ?? entry.relay }); continue }
        if (item.type !== 'event') continue
        const { event } = item
        if (signal.aborted) break
        if (!kinds.includes(event.kind)) continue
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
      entry.streams.delete(stream)
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
