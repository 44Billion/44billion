import {
  freeRelays,
  getLatestEventsByPubkey,
  getRelaysByPubkey as getUserRelays,
  nappRelays,
  relayPool as nostrRelays
} from 'libp2r2p/relay'
import { shouldIncludeNappRelays } from '#helpers/app.js'

export { getUserRelays }

const PROFILE_FALLBACK_RELAY_LIMIT = 3

export async function getSiteManifest (appIdObj, userRelays, { signal } = {}) {
  if (!appIdObj.pubkey || !appIdObj.kind || !appIdObj.dTag) throw new Error('Missing args')

  userRelays ??= (await getUserRelays([appIdObj.pubkey]))[appIdObj.pubkey]
  // if (userRelays.write.length === 0) return
  const relays = [...new Set([...userRelays.write, ...nappRelays])]

  const response = await nostrRelays.getEvents(
    { authors: [appIdObj.pubkey], kinds: [appIdObj.kind], '#d': [appIdObj.dTag], limit: 1 },
    relays,
    { timeoutAfterFirstEose: null, signal }
  )
  if (!response.success) {
    throw response.errors?.[0]?.reason ||
      new Error('Failed to fetch site manifest events')
  }
  const manifests = response.result ?? []
  return manifests.sort((a, b) => b.created_at - a.created_at)[0]
}
// Generic alias for fetching any parameterized replaceable event from relays by { kind, pubkey, dTag }
export const getEventByAddress = getSiteManifest

export async function getEventsByStrategy (filter, st /*, timeoutMs = 3000 */) {
  switch (st.code) {
    case 'WRITE_RELAYS': {
      if ((filter.authors?.length ?? 0) === 0 && (st.authors?.length ?? 0) === 0) throw new Error('Missing authors')
      const authors = st.authors || filter.authors

      // [[userPk, [...relays]]]
      const userWriteRelays = Object.entries(st.userRelays || await getUserRelays(authors)).map(([k, v]) => [k, v.write])
      const relayPopularity = {}
      userWriteRelays.forEach(v => v[1].forEach(v2 => {
        relayPopularity[v2] ??= 0
        relayPopularity[v2]++
      }))
      const relaysSortedByPopularity = Object.entries(relayPopularity).sort(([, a], [, b]) => b - a)
        .map(([k]) => k)

      const maxRelaysPerUser = st.maxRelaysPerUser || 2
      // Pick 2 for each author and split requests,
      // deduplicate and limit number of events
      // May include napp relays for all authors
      if (filter.authors) {
        const relayPickCountByUser = {}
        const usersByRelay = {}
        relaysSortedByPopularity.forEach(popularRelay => {
          userWriteRelays.forEach(([user, writeRelays]) => {
            if (!writeRelays.includes(popularRelay)) return

            relayPickCountByUser[user] ??= 0
            if (++relayPickCountByUser[user] > maxRelaysPerUser) return

            usersByRelay[popularRelay] ??= []
            usersByRelay[popularRelay].push(user)
          })
        })

        if (shouldIncludeNappRelays(filter)) {
          nappRelays.forEach(url => {
            usersByRelay[url] = filter.authors
          })
        }

        const promises = Object.entries(usersByRelay).map(([pickedRelay, authors]) =>
          nostrRelays.getEvents({ ...filter, authors }, [pickedRelay])
            .then(response => response.result ?? [])
        )

        const results = await Promise.allSettled(promises)
        const events = results
          .filter(r => r.status === 'fulfilled' && r.value)
          .flatMap(r => r.value)
          .sort((a, b) => b.created_at - a.created_at)

        const uniqueEvents = []
        const seenIds = new Set()
        const seenAddresses = new Set()

        const getEventAddress = (event) => {
          let dTagValue
          if ((event.kind >= 10000 && event.kind < 20000) || event.kind === 0 || event.kind === 3) {
            dTagValue = ''
          } else {
            const dTag = event.tags.find(v => v[0] === 'd')
            dTagValue = dTag?.[1]
          }

          if (typeof dTagValue !== 'string') return
          return `${event.kind}:${event.pubkey}:${dTagValue}`
        }

        for (const event of events) {
          if (filter.limit && uniqueEvents.length === filter.limit) break
          if (seenIds.has(event.id)) continue

          const addr = getEventAddress(event)
          if (addr) {
            if (seenAddresses.has(addr)) continue
            seenAddresses.add(addr)
          }

          seenIds.add(event.id)
          uniqueEvents.push(event)
        }

        return uniqueEvents
      // Pick 2 for each author but don't split requests.
      // it elects the faster relay to get all events from
      // May include napp relays for all authors
      } else { // st.authors
        const pickedRelays = new Set()
        if (shouldIncludeNappRelays(filter)) {
          nappRelays.forEach(url => pickedRelays.add(url))
        }

        userWriteRelays.forEach(v => {
          let pickedCountByAuthor = 0
          for (const r of relaysSortedByPopularity) {
            if (pickedCountByAuthor === maxRelaysPerUser) break
            if (!v[1].includes(r)) continue

            pickedCountByAuthor++
            pickedRelays.add(r)
          }
        })
        const { result } = await nostrRelays.getEvents(filter, [...pickedRelays])
        return result
      }
    }
    default: throw new Error('Pick a strategy')
  }
}

/**
 * Fetches publisher profiles in two batched stages.
 * The second stage only queries unresolved authors on remaining write relays
 * and a small, bounded set of public fallback relays.
 */
export async function getProfileEventsByPubkey (pubkeys, {
  _getUserRelays = getUserRelays,
  _nostrRelays = nostrRelays,
  _freeRelays = freeRelays
} = {}) {
  const { events } = await getLatestEventsByPubkey(pubkeys, {
    kinds: [0],
    fallbackRelays: _freeRelays.slice(0, PROFILE_FALLBACK_RELAY_LIMIT),
    _getRelaysByPubkey: _getUserRelays,
    _getEvents: (filter, relays) => _nostrRelays.getEvents(filter, relays)
  })
  return events
}
