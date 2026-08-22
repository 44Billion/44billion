import { base62ToBase16 } from 'libp2r2p/base62'
import { releaseAppSubdomain } from '#helpers/subdomain-mapping.js'
import { askAppToClearData } from './draft-app-runtime-reset.js'
import {
  cleanupNostrDbAppForWorkspace,
  hasAnyRecentSingleNappOpen,
  hasRecentSingleNappOpenForOwner
} from './nostrdb-app-lifecycle.js'

export async function defaultClearAppFiles (appId, {
  _loadAppFileManager = () => import('#services/app-file-manager/index.js')
} = {}) {
  const { default: AppFileManagerModule } = await _loadAppFileManager()
  return AppFileManagerModule.clearCachedFilesById(appId)
}

export function ownerPubkeyFromUserPk (userPk, { _base62ToBase16 = base62ToBase16 } = {}) {
  if (!userPk) return ''
  try {
    return _base62ToBase16(userPk, { mode: 'integer', byteLength: 32 }).toLowerCase()
  } catch (_error) {
    return ''
  }
}

export function countAppInstances ({ storage, appId, userPk }) {
  let hasOtherAnyInstances = false
  let hasOtherSameUserInstances = false
  for (const wsKey of storage?.session_workspaceKeys$?.() ?? []) {
    const appKeys = storage?.[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]?.() ?? []
    if (appKeys.length === 0) continue
    hasOtherAnyInstances = true
    if (storage?.[`session_workspaceByKey_${wsKey}_userPk$`]?.() === userPk) {
      hasOtherSameUserInstances = true
    }
  }
  return { hasOtherAnyInstances, hasOtherSameUserInstances }
}

export function removeAppInstance ({
  storage,
  tabStorage,
  wsKey,
  appKey,
  appId,
  userPk,
  appSubdomain = null
}) {
  const appKeys = storage?.[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]?.()
  if (!appKeys) throw new Error('Cannot remove app instance: app state is missing')
  const remainingInWorkspace = appKeys.filter(key => key !== appKey)

  tabStorage?.[`session_workspaceByKey_${wsKey}_openAppKeys$`]?.((v = [], eqKey) => {
    const index = v.indexOf(appKey)
    if (index !== -1) {
      v.splice(index, 1)
      if (eqKey) v[eqKey] = Math.random()
    }
    return v
  })
  storage?.[`session_appByKey_${appKey}_id$`]?.(undefined)
  tabStorage?.[`session_appByKey_${appKey}_visibility$`]?.(undefined)
  storage?.[`session_appByKey_${appKey}_route$`]?.(undefined)

  if (remainingInWorkspace.length === 0) {
    storage?.[`session_workspaceByKey_${wsKey}_pinnedAppIds$`]?.(
      v => (v ?? []).filter(v2 => v2 !== appId)
    )
    storage?.[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`]?.(
      v => (v ?? []).filter(v2 => v2 !== appId)
    )
    storage?.[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]?.(undefined)
  } else {
    storage?.[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]?.(remainingInWorkspace)
  }

  const instances = countAppInstances({ storage, appId, userPk })
  const resolvedAppSubdomain =
    storage?.[`session_subdomainByUserAndApp_${userPk}_${appId}$`]?.() ?? appSubdomain
  return {
    ...instances,
    appSubdomain: resolvedAppSubdomain,
    remainingInWorkspace: remainingInWorkspace.length
  }
}

export function clearAppMetadata ({ storage, appId }) {
  if (!appId) return false
  storage?.[`session_appById_${appId}_icon$`]?.(undefined)
  storage?.[`session_appById_${appId}_name$`]?.(undefined)
  storage?.[`session_appById_${appId}_description$`]?.(undefined)
  storage?.[`session_appById_${appId}_relayHints$`]?.(undefined)
  return true
}

export function removeAppFromWorkspace ({
  storage,
  tabStorage,
  wsKey,
  appKey,
  appId,
  userPk,
  appSubdomain = null
}) {
  return removeAppInstance({
    storage,
    tabStorage,
    wsKey,
    appKey,
    appId,
    userPk,
    appSubdomain
  })
}

export async function uninstallAppFromWorkspace ({
  storage,
  tabStorage,
  wsKey,
  appKey,
  appId,
  userPk,
  appSubdomain = null,
  preserveAppMetadata = false,
  _cleanupNostrDb = cleanupNostrDbAppForWorkspace,
  _askAppToClearData = askAppToClearData,
  _hasRecentSingleNappOpenForOwner = hasRecentSingleNappOpenForOwner,
  _hasAnyRecentSingleNappOpen = hasAnyRecentSingleNappOpen,
  _clearAppFiles = defaultClearAppFiles,
  _releaseAppSubdomain = releaseAppSubdomain,
  _base62ToBase16 = base62ToBase16
}) {
  await _cleanupNostrDb({
    storage,
    wsKey,
    appId,
    excludeWorkspaceKeys: [wsKey]
  })
  const removed = removeAppFromWorkspace({
    storage,
    tabStorage,
    wsKey,
    appKey,
    appId,
    userPk,
    appSubdomain
  })
  if (!removed.hasOtherAnyInstances && !preserveAppMetadata) {
    clearAppMetadata({ storage, appId })
  }
  await clearAppDataAfterRemoval({
    storage,
    wsKey,
    appId,
    userPk,
    appSubdomain: removed.appSubdomain,
    skipNostrDbCleanup: true,
    _askAppToClearData,
    _hasRecentSingleNappOpenForOwner,
    _hasAnyRecentSingleNappOpen,
    _clearAppFiles,
    _releaseAppSubdomain,
    _base62ToBase16
  })
  return removed
}

export async function clearAppDataAfterRemoval ({
  storage,
  wsKey,
  appId,
  userPk,
  appSubdomain = null,
  skipNostrDbCleanup = false,
  _cleanupNostrDb = cleanupNostrDbAppForWorkspace,
  _askAppToClearData = askAppToClearData,
  _hasRecentSingleNappOpenForOwner = hasRecentSingleNappOpenForOwner,
  _hasAnyRecentSingleNappOpen = hasAnyRecentSingleNappOpen,
  _clearAppFiles = defaultClearAppFiles,
  _releaseAppSubdomain = releaseAppSubdomain,
  _base62ToBase16 = base62ToBase16
} = {}) {
  if (!appId) return { clearedAppData: false, clearedAppFiles: false }

  const instances = countAppInstances({ storage, appId, userPk })
  const ownerPubkey = ownerPubkeyFromUserPk(userPk, { _base62ToBase16 })
  const recentForOwner = ownerPubkey
    ? await _hasRecentSingleNappOpenForOwner({ appId, ownerPubkey })
    : false
  const anyRecentSingleNapp =
    recentForOwner || await _hasAnyRecentSingleNappOpen({ appId })
  const resolvedAppSubdomain =
    storage?.[`session_subdomainByUserAndApp_${userPk}_${appId}$`]?.() ?? appSubdomain

  let clearedAppData = false
  let clearedAppFiles = false

  if (!instances.hasOtherSameUserInstances && !recentForOwner) {
    if (!skipNostrDbCleanup) {
      await _cleanupNostrDb({ storage, wsKey, appId })
    }
    if (resolvedAppSubdomain != null) {
      await _askAppToClearData(resolvedAppSubdomain)
      _releaseAppSubdomain(storage, {
        userPk,
        appId,
        subdomain: resolvedAppSubdomain
      })
    }
    clearedAppData = true
  }

  if (!instances.hasOtherAnyInstances && !anyRecentSingleNapp) {
    await _clearAppFiles(appId)
    clearedAppFiles = true
  }

  return {
    clearedAppData,
    clearedAppFiles,
    hasOtherAnyInstances: instances.hasOtherAnyInstances,
    hasOtherSameUserInstances: instances.hasOtherSameUserInstances
  }
}
