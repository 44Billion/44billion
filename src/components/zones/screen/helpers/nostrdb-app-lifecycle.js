import { base62ToBase16 } from '#helpers/base62.js'
import { removeVaultAcceptedMessage } from '#helpers/window-message/browser/vault-accepted-message-queue.js'
import { getNostrDb as defaultGetNostrDb } from '#services/idb/nostrdb/index.js'

export const NOSTRDB_APP_BACKFILL_CODE = 'NOSTRDB_APP_BACKFILL'

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

export async function cleanupNostrDbAppForWorkspace ({
  storage,
  wsKey,
  appId,
  excludeWorkspaceKeys,
  excludeAppKeys,
  getNostrDb = defaultGetNostrDb
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

  removeVaultAcceptedMessage({
    code: NOSTRDB_APP_BACKFILL_CODE,
    payload: { ownerPubkey, appId }
  })

  try {
    await getNostrDb(ownerPubkey).deleteEventsByApp(appId)
  } catch (err) {
    console.warn('Failed to clean up NostrDB app data', err)
  }
  return true
}
