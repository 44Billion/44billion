import { isLocalDevApp } from '#services/local-dev/state.js'
import { getSiteManifest as getSiteManifestFromRelays } from '#helpers/nostr-queries.js'
import { saveSiteManifestToDb, getSiteManifestFromDb } from '#services/idb/browser/queries/site-manifest.js'

export default async function getSiteManifestEvent (appId, appAddressObj, { signal } = {}) {
  let siteManifest = await getSiteManifestFromDb(appId)
  if (siteManifest) return siteManifest

  if (isLocalDevApp(appId)) throw new Error('Local app manifest is missing; restart the local watcher')
  siteManifest = await getSiteManifestFromRelays(appAddressObj, undefined, { signal })
  if (siteManifest) await saveSiteManifestToDb(siteManifest)
  return siteManifest
}
