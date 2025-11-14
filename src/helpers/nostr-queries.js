import nostrRelays, { seedRelays } from '#services/nostr-relays.js'

export async function getAppBundle (appIdObj, userRelays) {
  if (!appIdObj.pubkey || !appIdObj.kind || !appIdObj.dTag) throw new Error('Missing args')

  userRelays ??= (await getUserRelays(appIdObj.pubkey))[appIdObj.pubkey]
  if (userRelays.write.length === 0) return

  const bundlesResponse = await nostrRelays.getEvents(
    { authors: [appIdObj.pubkey], kinds: [appIdObj.kind], '#d': [appIdObj.dTag], limit: 1 },
    userRelays.write
  )
  if (!bundlesResponse.success) {
    throw bundlesResponse.errors?.[0]?.reason ||
      new Error('Failed to fetch app bundle events')
  }
  const bundles = bundlesResponse.result ?? []
  return bundles.sort((a, b) => b.created_at - a.created_at)[0]
}

export async function getEventsByStrategy (filter, st /*, timeoutMs = 3000 */) {
  switch (st.code) {
    case 'WRITE_RELAYS': {
      if ((filter.authors?.length ?? 0) === 0 && (st.authors?.length ?? 0) === 0) throw new Error('Missing authors')
      const authors = st.authors || filter.authors

      // [[userPk, [...relays]]]
      const userWriteRelays = Object.entries(await getUserRelays(authors)).map(([k, v]) => [k, v.write])
      const relayPopularity = {}
      userWriteRelays.forEach(v => v[1].forEach(v2 => {
        relayPopularity[v2] ??= 0
        relayPopularity[v2]++
      }))
      const relaysSortedByPopularity = Object.entries(relayPopularity).sort(([, a], [, b]) => b - a)
        .map(([k]) => k)

      const maxRelaysPerUser = st.maxRelaysPerUser || 2
      // pick 2 for each author and split requests,
      // deduplicate and limit number of events
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
        const promises = Object.entries(usersByRelay).map(([pickedRelay, authors]) =>
          nostrRelays.getEventsAsap({ ...filter, authors }, [pickedRelay])
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
      } else { // st.authors
        // pick 2 for each author but don't split requests.
        // it elects the faster relay to get all events from
        const pickedRelays = new Set()
        userWriteRelays.forEach(v => {
          let pickedCountByAuthor = 0
          for (const r of relaysSortedByPopularity) {
            if (pickedCountByAuthor === maxRelaysPerUser) break
            if (!v[1].includes(r)) continue

            pickedCountByAuthor++
            pickedRelays.add(r)
          }
        })
        const { result } = await nostrRelays.getEventsAsap(filter, [...pickedRelays])
        return result
      }
    }
    default: throw new Error('Pick a strategy')
  }
}

async function getUserRelays (authors) {
  if (!Array.isArray(authors)) authors = [authors]
  const relayListsResponse = await nostrRelays.getEvents({ authors, kinds: [10002], limit: authors.length }, seedRelays)
  if (!relayListsResponse.success) {
    throw relayListsResponse.errors?.[0]?.reason ||
      new Error('Failed to fetch relay lists')
  }
  const relayLists = relayListsResponse.result ?? []
  const seenAuthorsObj = {}
  const keyAllowList = { read: true, write: true }
  const defaultRelayTypes = Object.keys(keyAllowList)
  let keys

  const ret = authors.reduce((r, v) => ({ ...r, [v]: { read: new Set(), write: new Set() } }), {})
  const result = relayLists
    // get most recent
    .sort((a, b) => b.created_at - a.created_at)
    // for each author
    .filter(v => {
      if (!seenAuthorsObj[v.pubkey] && authors.includes(v.pubkey)) seenAuthorsObj[v.pubkey] = true
      return seenAuthorsObj[v.pubkey]
    })
    .reduce((r, v) => {
      ;(v.tags ?? []).filter(v2 => v2[0] === 'r' && /^wss?:\/\//.test(v2[1]))
        .forEach((v3) => {
          keys = [v3[2]].filter(v2 => keyAllowList[v2])
          if (keys.length === 0) keys = defaultRelayTypes
          keys.forEach(k => r[v.pubkey][k].add(v3[1]))
        })
      return r
    }, ret)

  // sets to arrays
  for (const pubkey in result) {
    defaultRelayTypes.forEach(k => {
      result[pubkey][k] = [...result[pubkey][k]]
    })
  }

  return result
}
