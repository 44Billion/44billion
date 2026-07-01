import { base62ToBase16 } from '#helpers/base62.js'
import {
  cleanupNostrDbAppForOwner as cleanupNostrDbAppForOwnerBase,
  NOSTRDB_APP_BACKFILL_CODE
} from '#helpers/nostrdb-app-cleanup.js'
import {
  getSiteManifestFromDb as defaultGetSiteManifestFromDb,
  normalizeSingleNappOpenedAtByOwner,
  saveSiteManifestToDb as defaultSaveSiteManifestToDb
} from '#services/idb/browser/queries/site-manifest.js'
import { getNostrDb as defaultGetNostrDb } from '#services/idb/nostrdb/index.js'

export { NOSTRDB_APP_BACKFILL_CODE }
export const SINGLE_NAPP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const HEX32 = /^[0-9a-f]{64}$/i

function asSet (value) {
  if (value instanceof Set) return value
  return new Set(Array.isArray(value) ? value : [])
}

export function workspaceOwnerPubkey (storage, wsKey) {
  const userPk = storage?.[`session_workspaceByKey_${wsKey}_userPk$`]?.()
  if (!userPk || userPk === storage?.session_defaultUserPk$?.()) return ''
  try {
    const pubkey = base62ToBase16(userPk).toLowerCase()
    return HEX32.test(pubkey) ? pubkey : ''
  } catch {
    return ''
  }
}

export function isNostrDbAppInstalledForOwner ({
  storage,
  ownerPubkey,
  appId,
  excludeWorkspaceKeys,
  excludeAppKeys
} = {}) {
  const owner = typeof ownerPubkey === 'string' ? ownerPubkey.toLowerCase() : ''
  if (!HEX32.test(owner) || !appId) return false

  const excludedWorkspaces = asSet(excludeWorkspaceKeys)
  const excludedAppKeys = asSet(excludeAppKeys)

  for (const wsKey of storage?.session_workspaceKeys$?.() || []) {
    if (excludedWorkspaces.has(wsKey)) continue
    if (workspaceOwnerPubkey(storage, wsKey) !== owner) continue
    const appKeys = storage?.[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]?.() || []
    if (appKeys.some(appKey => !excludedAppKeys.has(appKey))) return true
  }
  return false
}

export function recentSingleNappOwnersFromManifest (
  manifest,
  {
    now = Date.now(),
    retentionMs = SINGLE_NAPP_RETENTION_MS
  } = {}
) {
  const owners = normalizeSingleNappOpenedAtByOwner(manifest?.meta?.singleNappOpenedAtByOwner)
  const cutoff = now - retentionMs
  return Object.fromEntries(
    Object.entries(owners).filter(([, openedAt]) => openedAt >= cutoff)
  )
}

export async function hasRecentSingleNappOpenForOwner ({
  appId,
  ownerPubkey,
  getSiteManifestFromDb = defaultGetSiteManifestFromDb,
  now = Date.now(),
  retentionMs = SINGLE_NAPP_RETENTION_MS
} = {}) {
  const owner = typeof ownerPubkey === 'string' ? ownerPubkey.toLowerCase() : ''
  if (!appId || !HEX32.test(owner)) return false
  const manifest = await getSiteManifestFromDb(appId)
  return recentSingleNappOwnersFromManifest(manifest, { now, retentionMs })[owner] != null
}

export async function hasAnyRecentSingleNappOpen ({
  appId,
  getSiteManifestFromDb = defaultGetSiteManifestFromDb,
  now = Date.now(),
  retentionMs = SINGLE_NAPP_RETENTION_MS
} = {}) {
  if (!appId) return false
  const manifest = await getSiteManifestFromDb(appId)
  return Object.keys(recentSingleNappOwnersFromManifest(manifest, { now, retentionMs })).length > 0
}

export async function cleanupNostrDbAppForOwner ({
  ownerPubkey,
  appId,
  getNostrDb = defaultGetNostrDb,
  getSiteManifestFromDb = defaultGetSiteManifestFromDb,
  saveSiteManifestToDb = defaultSaveSiteManifestToDb
} = {}) {
  return cleanupNostrDbAppForOwnerBase({
    ownerPubkey,
    appId,
    getNostrDb,
    getSiteManifestFromDb,
    saveSiteManifestToDb
  })
}

export async function cleanupNostrDbAppForWorkspace ({
  storage,
  wsKey,
  appId,
  excludeWorkspaceKeys,
  excludeAppKeys,
  getNostrDb = defaultGetNostrDb,
  getSiteManifestFromDb = defaultGetSiteManifestFromDb,
  saveSiteManifestToDb = defaultSaveSiteManifestToDb,
  now = Date.now(),
  retentionMs = SINGLE_NAPP_RETENTION_MS
} = {}) {
  const ownerPubkey = workspaceOwnerPubkey(storage, wsKey)
  if (!ownerPubkey || !appId) return false
  if (isNostrDbAppInstalledForOwner({
    storage,
    ownerPubkey,
    appId,
    excludeWorkspaceKeys,
    excludeAppKeys
  })) return false

  if (await hasRecentSingleNappOpenForOwner({
    appId,
    ownerPubkey,
    getSiteManifestFromDb,
    now,
    retentionMs
  })) return false

  return cleanupNostrDbAppForOwner({
    ownerPubkey,
    appId,
    getNostrDb,
    getSiteManifestFromDb,
    saveSiteManifestToDb
  })
}
