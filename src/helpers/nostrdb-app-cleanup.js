import { removeVaultAcceptedMessage } from '#helpers/window-message/browser/vault-accepted-message-queue.js'
import {
  getSiteManifestFromDb as defaultGetSiteManifestFromDb,
  normalizeSingleNappOpenedAtByOwner,
  saveSiteManifestToDb as defaultSaveSiteManifestToDb
} from '#services/idb/browser/queries/site-manifest.js'

export const NOSTRDB_APP_BACKFILL_CODE = 'NOSTRDB_APP_BACKFILL'

const HEX32 = /^[0-9a-f]{64}$/i

function defaultGetNostrDb (ownerPubkey) {
  return {
    async deleteEventsByApp (appId) {
      const { getNostrDb } = await import('#services/idb/nostrdb/index.js')
      return getNostrDb(ownerPubkey).deleteEventsByApp(appId)
    }
  }
}

export async function removeSingleNappOwnerFromManifest ({
  appId,
  ownerPubkey,
  getSiteManifestFromDb = defaultGetSiteManifestFromDb,
  saveSiteManifestToDb = defaultSaveSiteManifestToDb
} = {}) {
  const owner = typeof ownerPubkey === 'string' ? ownerPubkey.toLowerCase() : ''
  if (!appId || !HEX32.test(owner)) return false

  const manifest = await getSiteManifestFromDb(appId)
  const owners = normalizeSingleNappOpenedAtByOwner(manifest?.meta?.singleNappOpenedAtByOwner)
  if (owners[owner] == null) return false

  delete owners[owner]
  await saveSiteManifestToDb(manifest, {
    ...manifest.meta,
    singleNappOpenedAtByOwner: owners
  })
  return true
}

export async function cleanupNostrDbAppForOwner ({
  ownerPubkey,
  appId,
  getNostrDb = defaultGetNostrDb,
  getSiteManifestFromDb = defaultGetSiteManifestFromDb,
  saveSiteManifestToDb = defaultSaveSiteManifestToDb,
  removeAcceptedMessage = removeVaultAcceptedMessage,
  updateSingleNappManifest = true,
  logPrefix = 'Failed to clean up NostrDB app data'
} = {}) {
  const owner = typeof ownerPubkey === 'string' ? ownerPubkey.toLowerCase() : ''
  if (!HEX32.test(owner) || !appId) return false

  removeAcceptedMessage({
    code: NOSTRDB_APP_BACKFILL_CODE,
    payload: { ownerPubkey: owner, appId }
  })

  try {
    await getNostrDb(owner).deleteEventsByApp(appId)
  } catch (err) {
    console.warn(logPrefix, err)
  }
  if (updateSingleNappManifest) {
    await removeSingleNappOwnerFromManifest({
      appId,
      ownerPubkey: owner,
      getSiteManifestFromDb,
      saveSiteManifestToDb
    })
  }
  return true
}
