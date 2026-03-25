import { getSiteManifest as getSiteManifestFromRelays } from '#helpers/nostr-queries.js'
import { saveSiteManifestToDb, getSiteManifestFromDb } from '#services/idb/browser/queries/site-manifest.js'

export default async function getSiteManifestEvent (appId, appAddressObj) {
  let siteManifest = await getSiteManifestFromDb(appId)
  if (siteManifest) return siteManifest

  siteManifest = await getSiteManifestFromRelays(appAddressObj)
  if (siteManifest) await saveSiteManifestToDb(siteManifest)
  return siteManifest
}
