import { getEventsByStrategy } from '#helpers/nostr-queries.js'
import { getBundleEvent } from '#services/app-file-manager/get-bundle-event.js'
import { appIdToAddressObj } from '#helpers/app.js'
import nostrRelays from '#services/nostr-relays.js'

export async function getAppBundleResponse (appId) {
  try {
    const appAddressObj = appIdToAddressObj(appId)

    return { payload: (await getBundleEvent(appId, appAddressObj)) || null }
  } catch (error) {
    return { error }
  }
}

export async function getEventsMessage (filter, relays) {
  try {
    // this means that the one requesting the events already picked the relays
    if (relays.length > 0) return nostrRelays.getEventsAsap(filter, relays)

    // TODO: infer the strategy by looking at the filter
    const strategy = { code: 'WRITE_RELAYS' }
    return { payload: await getEventsByStrategy(filter, strategy) }
  } catch (error) {
    return { error }
  }
}
