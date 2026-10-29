import { freeRelays, relayPool, getRelaysByPubkey } from 'libp2r2p/relay'
import { isValidPublicRelayUrl, normalizeRelayUrl } from 'libp2r2p/url'
import { verifyEvent } from 'nostr-tools/pure'
import { matchFilters } from 'nostr-tools/filter'
import { createRelayPoolOutboxRouter } from '@kehto/services'

export function createNappletNetwork ({ account, signal, pool = relayPool, loadRelays = getRelaysByPubkey }) {
  const subscriptions = new Set()
  const allowedRelays = urls => [...new Set((urls || []).filter(isValidPublicRelayUrl).map(normalizeRelayUrl))].slice(0, 16)
  const relaysFor = async pubkeys => {
    account.guard()
    const result = await loadRelays(pubkeys, { signal })
    account.guard()
    return new Map(pubkeys.map(pubkey => [pubkey, { read: allowedRelays(result[pubkey]?.read), write: allowedRelays(result[pubkey]?.write) }]))
  }
  const subscribe = (filters, relayUrls, onEvent) => {
    account.guard()
    const controller = new AbortController()
    const lifetime = AbortSignal.any([signal, controller.signal])
    const streams = []
    const close = () => {
      controller.abort()
      subscriptions.delete(close)
      for (const stream of streams) Promise.resolve(stream.return()).catch(() => {})
    }
    subscriptions.add(close)
    let pending = filters.length
    const urls = allowedRelays(relayUrls)
    for (const filter of filters) {
      ;(async () => {
        try {
          const stream = pool.getEventsFeedGenerator(filter, urls, { signal: lifetime, timeout: 10000, timeoutAfterFirstEose: null })
          streams.push(stream)
          let eose = false
          for await (const item of stream) {
            if (lifetime.aborted) break
            account.guard()
            if (item.type === 'event' && verifyEvent(item.event) && matchFilters(filters, item.event)) onEvent(item.event)
            if (!eose && item.type === 'eose' && (!item.relays || (item.relays.length && item.relays.every(relay => ['eose', 'satisfied'].includes(relay.status))))) { eose = true; if (--pending === 0) onEvent('EOSE') }
          }
        } catch {
          // A failed stream is not a completed snapshot. Let the outbox
          // deadline mark it incomplete so list edits cannot overwrite data.
        }
      })()
    }
    return { unsubscribe: close }
  }
  const publish = async (event, urls) => {
    account.guard()
    if (!verifyEvent(event) || event.pubkey !== account.getPublicKey()) throw new Error('INVALID_PUBLICATION')
    const relays = allowedRelays(urls)
    const request = await pool.sendEvent(event, relays, { signal })
    const result = await request.promise
    account.guard()
    return Object.fromEntries(relays.map(url => [url, (result.succeededRelays || []).includes(url)]))
  }
  const router = createRelayPoolOutboxRouter({
    relayPool: { subscribe, publish, isAvailable: () => !signal.aborted },
    loadRelayLists: relaysFor, fallbackRelays: freeRelays,
    signEvent: template => account.signEvent(template), verifyEvent,
    isRelayAllowed: isValidPublicRelayUrl, defaultTimeoutMs: 10000
  })
  const getRelays = async () => {
    const pubkey = account.getPublicKey()
    const entry = pubkey ? (await relaysFor([pubkey])).get(pubkey) : { read: freeRelays, write: freeRelays }
    return Object.fromEntries([...new Set([...entry.read, ...entry.write])].map(url => [url, { read: entry.read.includes(url), write: entry.write.includes(url) }]))
  }
  return {
    router, getRelays, subscribe, publish, allowedRelays,
    async count (filters) {
      account.guard()
      if (filters.length !== 1) return { ok: false, error: 'unsupported-filter', reason: 'Multi-filter COUNT cannot be combined without double counting' }
      const plan = await router.resolveRelays({ authors: filters[0].authors })
      const result = await pool.countEvents(filters[0], plan.relays, { signal, timeout: 10000 })
      account.guard()
      return result.success ? { ok: true, count: result.count, approximate: result.approximate, relays: plan.relays } : { ok: false, error: 'count-unavailable' }
    },
    close () { for (const close of [...subscriptions]) close() }
  }
}
