import AppFileManager from '#services/app-file-manager/index.js'
import AppUpdater from '#services/app-updater/index.js'
import {
  cleanupNostrDbAppForOwner
} from '#helpers/nostrdb-app-cleanup.js'
import {
  hasAnyRecentSingleNappOpen
} from '#components/zones/screen/helpers/nostrdb-app-lifecycle.js'
import {
  deleteAllPermissionsForApp
} from '#services/idb/browser/queries/permission.js'
import {
  addSubdomainFreeId,
  normalizeSubdomainFreeIds
} from '#helpers/subdomain-mapping.js'

function setStoredValue (storage, key, value) {
  if (value === null || value === undefined) storage?.removeItem?.(key)
  else storage?.setItem?.(key, JSON.stringify(value))
}

function removeKeysWithPrefix (storage, prefix) {
  if (!storage || typeof storage.length !== 'number' || typeof storage.key !== 'function') return
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index)
    if (typeof key === 'string' && key.startsWith(prefix)) storage.removeItem(key)
  }
}

function readJson (storage, key, fallback) {
  const raw = storage?.getItem?.(key)
  if (raw == null) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

async function deleteNostrDbOwner (ownerPubkey) {
  if (!ownerPubkey) return false
  const { deleteNostrDb } = await import('#services/idb/nostrdb/index.js')
  return deleteNostrDb(ownerPubkey)
}

async function removeAppData (appId, ownerPubkey, localStorageArea) {
  const results = { appId, nostrDb: false, files: false }
  if (ownerPubkey) {
    try {
      await cleanupNostrDbAppForOwner({ ownerPubkey, appId })
      results.nostrDb = true
    } catch (error) {
      console.warn(`[storage-audit] Failed to clean NostrDB app ${appId}`, error)
    }
  }

  try {
    await deleteAllPermissionsForApp(appId)
  } catch (error) {
    console.warn(`[storage-audit] Failed to delete permissions for ${appId}`, error)
  }

  let recentSingleNapp = false
  try {
    recentSingleNapp = await hasAnyRecentSingleNappOpen({ appId })
  } catch (error) {
    console.warn(`[storage-audit] Failed to check single-napp retention for ${appId}`, error)
  }

  if (recentSingleNapp) return results

  try {
    await AppFileManager.clearCachedFilesById(appId)
    results.files = true
  } catch (error) {
    console.warn(`[storage-audit] Failed to clear cached files for ${appId}`, error)
  }
  AppUpdater.clearCachedAppMetadata(appId, { _localStorage: localStorageArea })
  AppUpdater.removeSubdomainMappingsForApp(appId, { _localStorage: localStorageArea })
  return results
}

export async function applyStorageRepairPlan (plan, {
  localStorageArea,
  sessionStorageArea
} = {}) {
  if (!plan || typeof plan !== 'object') return null

  for (const [key, value] of Object.entries(plan.local ?? {})) {
    setStoredValue(localStorageArea, key, value)
  }
  for (const [key, value] of Object.entries(plan.session ?? {})) {
    setStoredValue(sessionStorageArea, key, value)
  }

  for (const item of plan.removeWorkspaces ?? []) {
    removeKeysWithPrefix(localStorageArea, `session_workspaceByKey_${item.wsKey}_`)
    removeKeysWithPrefix(sessionStorageArea, `session_workspaceByKey_${item.wsKey}_`)
  }

  for (const item of plan.removeAppInstances ?? []) {
    setStoredValue(localStorageArea, `session_appByKey_${item.appKey}_id`, null)
    setStoredValue(localStorageArea, `session_appByKey_${item.appKey}_route`, null)
    setStoredValue(sessionStorageArea, `session_appByKey_${item.appKey}_visibility`, null)
  }

  const ownersToDelete = new Set(plan.removeNostrDbOwners ?? [])
  for (const item of plan.removeAccounts ?? []) {
    for (const suffix of ['_isReadOnly', '_isLocked', '_profile', '_relays']) {
      setStoredValue(localStorageArea, `session_accountByUserPk_${item.userPk}${suffix}`, null)
    }
    if (item.ownerPubkey) ownersToDelete.add(item.ownerPubkey)
  }

  let freeIds = normalizeSubdomainFreeIds(readJson(localStorageArea, 'session_subdomainFreeIds', []))
  for (const item of plan.releaseSubdomains ?? []) {
    if (!item?.subdomain || !item?.userPk || !item?.appId) continue
    setStoredValue(localStorageArea, `session_subdomainByUserAndApp_${item.userPk}_${item.appId}`, null)
    setStoredValue(localStorageArea, `session_subdomainToApp_${item.subdomain}`, null)
    freeIds = addSubdomainFreeId(freeIds, item.subdomain)
  }
  if (freeIds.length > 0) {
    setStoredValue(localStorageArea, 'session_subdomainFreeIds', freeIds)
  } else {
    setStoredValue(localStorageArea, 'session_subdomainFreeIds', null)
  }

  const removedApps = []
  for (const item of plan.removeApps ?? []) {
    removedApps.push(await removeAppData(item.appId, item.ownerPubkey, localStorageArea))
  }

  const removedOwners = []
  for (const ownerPubkey of ownersToDelete) {
    if (await deleteNostrDbOwner(ownerPubkey)) removedOwners.push(ownerPubkey)
  }

  return { removedApps, removedOwners }
}
