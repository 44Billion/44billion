import { getAppBundle as getBundleEventFromRelays } from '#helpers/nostr-queries.js'
import { saveBundleToDb, getBundleFromDb } from '#services/idb/browser/queries/bundle.js'

export default async function getBundleEvent (appId, appAddressObj) {
  let bundleEvent = await getBundleFromDb(appId)
  if (bundleEvent) return bundleEvent

  bundleEvent = await getBundleEventFromRelays(appAddressObj)
  if (bundleEvent) await saveBundleToDb(bundleEvent)
  return bundleEvent
}
