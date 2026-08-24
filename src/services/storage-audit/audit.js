import { base62ToBase16 } from 'libp2r2p/base62'
import {
  ACCOUNT_SUFFIXES,
  APP_INSTANCE_LOCAL_SUFFIXES,
  APP_INSTANCE_SESSION_SUFFIXES,
  APP_METADATA_SUFFIXES,
  WORKSPACE_LOCAL_SUFFIXES,
  WORKSPACE_SESSION_SUFFIXES
} from '#constants/storage-schema.js'

export const STORAGE_REPAIR_PLAN_VERSION = 1

const HEX32 = /^[0-9a-f]{64}$/i

const APP_VISIBILITY = new Set(['open', 'minimized', 'closed'])

function storageSnapshot (storage) {
  const entries = new Map()
  if (!storage || typeof storage.length !== 'number' || typeof storage.key !== 'function') {
    return entries
  }

  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key == null) continue
    const raw = storage.getItem(key)
    let value
    let invalid = false
    if (raw != null) {
      try {
        value = JSON.parse(raw)
      } catch {
        invalid = true
      }
    }
    entries.set(key, { value, invalid })
  }
  return entries
}

function getValue (snapshot, key) {
  return snapshot.get(key)?.value
}

function isInvalid (snapshot, key) {
  return snapshot.get(key)?.invalid === true
}

function toIssue (code, message, details = undefined) {
  return details === undefined ? { code, message } : { code, message, details }
}

function uniqueStrings (value) {
  return [...new Set(value)]
}

function readStoredJson (storage, key) {
  const raw = storage?.getItem?.(key)
  if (raw == null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function toPlainObject (value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function toPublicKeyHex (userPk) {
  if (typeof userPk !== 'string' || !userPk) return ''
  try {
    const hex = base62ToBase16(userPk, { mode: 'integer', byteLength: 32 }).toLowerCase()
    return HEX32.test(hex) ? hex : ''
  } catch {
    return ''
  }
}

function suffixForPrefix (key, prefix) {
  return key.startsWith(prefix) ? key.slice(prefix.length) : null
}

function extractDynamicId (key, prefixes, suffixes) {
  for (const prefix of prefixes) {
    const rest = suffixForPrefix(key, prefix)
    if (rest == null) continue
    for (const suffix of suffixes) {
      if (rest.endsWith(suffix)) return rest.slice(0, -suffix.length)
    }
  }
  return null
}

function createEmptyPlan () {
  return {
    version: STORAGE_REPAIR_PLAN_VERSION,
    codeVersion: '',
    issues: [],
    local: {},
    session: {},
    removeWorkspaces: [],
    removeAppInstances: [],
    removeApps: [],
    removeAccounts: [],
    removeNostrDbOwners: [],
    releaseSubdomains: []
  }
}

export function hasStorageRepairActions (plan) {
  return Boolean(
    plan?.issues?.some(issue => issue.actionable !== false) ||
    Object.keys(plan?.local ?? {}).length ||
    Object.keys(plan?.session ?? {}).length ||
    plan?.removeWorkspaces?.length ||
    plan?.removeAppInstances?.length ||
    plan?.removeApps?.length ||
    plan?.removeAccounts?.length ||
    plan?.removeNostrDbOwners?.length ||
    plan?.releaseSubdomains?.length
  )
}

// Pure filtering of an openAppKeys list. `getLocal`/`getSession` are key
// readers so the same rule works over audit snapshots or raw Storage areas.
export function normalizeOpenAppKeyList (openAppKeys, {
  referencedAppKeys,
  getLocal,
  getSession
}) {
  const unique = uniqueStrings(Array.isArray(openAppKeys) ? openAppKeys : [])
  return unique.filter(appKey => {
    const appId = getLocal(`session_appByKey_${appKey}_id`)
    return referencedAppKeys.has(appKey) &&
      typeof appId === 'string' &&
      getSession(`session_appByKey_${appKey}_visibility`) === 'open'
  })
}

// Pre-render repair: applies the openAppKeys normalization directly to
// sessionStorage on every load, without scheduling a reload. Logs whenever it
// changes something so a recurring corruption is visible in the console.
export function normalizeOpenAppKeysInStorage ({
  localStorageArea = globalThis.localStorage,
  sessionStorageArea = globalThis.sessionStorage
} = {}) {
  const workspaceKeys = readStoredJson(localStorageArea, 'session_workspaceKeys')
  if (!Array.isArray(workspaceKeys)) return { changed: 0, workspaces: [] }

  const referencedAppKeys = new Set()
  for (const wsKey of workspaceKeys) {
    if (typeof wsKey !== 'string') continue
    for (const listKey of [
      `session_workspaceByKey_${wsKey}_pinnedAppIds`,
      `session_workspaceByKey_${wsKey}_unpinnedAppIds`
    ]) {
      const appIds = readStoredJson(localStorageArea, listKey)
      if (!Array.isArray(appIds)) continue
      for (const appId of appIds) {
        if (typeof appId !== 'string') continue
        const appKeys = readStoredJson(
          localStorageArea,
          `session_workspaceByKey_${wsKey}_appById_${appId}_appKeys`
        )
        if (!Array.isArray(appKeys)) continue
        for (const appKey of appKeys) {
          if (typeof appKey === 'string') referencedAppKeys.add(appKey)
        }
      }
    }
  }

  const getLocal = key => readStoredJson(localStorageArea, key)
  const getSession = key => readStoredJson(sessionStorageArea, key)
  const changedWorkspaces = []

  for (const wsKey of workspaceKeys) {
    if (typeof wsKey !== 'string') continue
    const key = `session_workspaceByKey_${wsKey}_openAppKeys`
    const stored = readStoredJson(sessionStorageArea, key)
    if (!Array.isArray(stored)) continue

    const normalized = normalizeOpenAppKeyList(stored, {
      referencedAppKeys,
      getLocal,
      getSession
    })
    if (normalized.length === stored.length) continue

    sessionStorageArea?.setItem?.(key, JSON.stringify(normalized))
    const removedKeys = stored.filter(appKey => !normalized.includes(appKey))
    changedWorkspaces.push({ wsKey, from: stored.length, to: normalized.length })
    console.warn(
      `[storage-audit] Normalized openAppKeys for workspace ${wsKey}: ` +
      `${stored.length} -> ${normalized.length} entry(ies)` +
      (removedKeys.length > 0
        ? ` (removed ${removedKeys.length} stale/duplicate/non-open app instance(s): ${removedKeys.join(', ')})`
        : '')
    )
  }

  return { changed: changedWorkspaces.length, workspaces: changedWorkspaces }
}

// Pre-render repair for the core localStorage lists: dedupes
// session_workspaceKeys and session_accountUserPks, and keeps
// session_openWorkspaceKeys as a deduped subset of workspaceKeys. Applies
// directly on every load without scheduling a reload, and logs whenever it
// changes something. Missing values and values that are not arrays of
// non-empty strings are left untouched; the audit reports those as issues.
export function normalizeCoreListsInStorage ({
  localStorageArea = globalThis.localStorage
} = {}) {
  const read = key => readStoredJson(localStorageArea, key)
  const isValidStringList = value =>
    Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0)
  const changedLists = []

  const workspaceKeys = read('session_workspaceKeys')
  if (isValidStringList(workspaceKeys)) {
    const normalized = uniqueStrings(workspaceKeys)
    if (normalized.length !== workspaceKeys.length) {
      localStorageArea?.setItem?.('session_workspaceKeys', JSON.stringify(normalized))
      changedLists.push({
        key: 'session_workspaceKeys',
        from: workspaceKeys.length,
        to: normalized.length
      })
      console.warn(
        `[storage-audit] Normalized session_workspaceKeys: ${workspaceKeys.length} -> ${normalized.length} entry(ies) ` +
        `(removed ${workspaceKeys.length - normalized.length} duplicate(s))`
      )
    }
  }

  const accountUserPks = read('session_accountUserPks')
  if (isValidStringList(accountUserPks)) {
    const normalized = uniqueStrings(accountUserPks)
    if (normalized.length !== accountUserPks.length) {
      localStorageArea?.setItem?.('session_accountUserPks', JSON.stringify(normalized))
      changedLists.push({
        key: 'session_accountUserPks',
        from: accountUserPks.length,
        to: normalized.length
      })
      console.warn(
        `[storage-audit] Normalized session_accountUserPks: ${accountUserPks.length} -> ${normalized.length} entry(ies) ` +
        `(removed ${accountUserPks.length - normalized.length} duplicate(s))`
      )
    }
  }

  const openWorkspaceKeys = read('session_openWorkspaceKeys')
  if (isValidStringList(openWorkspaceKeys) && isValidStringList(workspaceKeys)) {
    const workspaceSet = new Set(uniqueStrings(workspaceKeys))
    const normalized = uniqueStrings(openWorkspaceKeys.filter(wsKey => workspaceSet.has(wsKey)))
    if (normalized.length !== openWorkspaceKeys.length) {
      localStorageArea?.setItem?.('session_openWorkspaceKeys', JSON.stringify(normalized))
      const removed = openWorkspaceKeys.filter(wsKey => !normalized.includes(wsKey))
      changedLists.push({
        key: 'session_openWorkspaceKeys',
        from: openWorkspaceKeys.length,
        to: normalized.length
      })
      console.warn(
        `[storage-audit] Normalized session_openWorkspaceKeys: ${openWorkspaceKeys.length} -> ${normalized.length} entry(ies) ` +
        (removed.length > 0
          ? `(removed stale/duplicate workspace key(s): ${removed.join(', ')})`
          : '(duplicate(s) removed)')
      )
    }
  }

  return { changed: changedLists.length, lists: changedLists }
}

export function normalizePersistedListsInStorage (options) {
  const core = normalizeCoreListsInStorage(options)
  const openAppKeys = normalizeOpenAppKeysInStorage(options)
  return {
    changed: core.changed + openAppKeys.changed,
    core: core.lists,
    openAppKeys: openAppKeys.workspaces
  }
}

export function auditPersistedState (localStorageArea, sessionStorageArea, {
  manifestAppIds = new Set()
} = {}) {
  const local = storageSnapshot(localStorageArea)
  const session = storageSnapshot(sessionStorageArea)
  const plan = createEmptyPlan()
  const issues = plan.issues
  const setLocal = (key, value) => {
    plan.local[key] = value === undefined ? null : value
  }
  const setSession = (key, value) => {
    plan.session[key] = value === undefined ? null : value
  }
  const issue = (code, message, details, actionable = true) => {
    const item = toIssue(code, message, details)
    if (!actionable) item.actionable = false
    issues.push(item)
  }

  const workspaceKeysRaw = getValue(local, 'session_workspaceKeys')
  let workspaceKeys = toPlainArrayValue('session_workspaceKeys', local, setLocal, issue)
  workspaceKeys = uniqueStrings(workspaceKeys)
  if (Array.isArray(workspaceKeysRaw) && workspaceKeys.length !== workspaceKeysRaw.length) {
    console.warn(
      `[storage-audit] session_workspaceKeys would change: ${workspaceKeysRaw.length} -> ${workspaceKeys.length} entry(ies) (duplicate(s) removed)`
    )
  }

  const accountUserPksRaw = getValue(local, 'session_accountUserPks')
  let accountUserPks = toPlainArrayValue('session_accountUserPks', local, setLocal, issue)
  accountUserPks = uniqueStrings(accountUserPks)
  if (Array.isArray(accountUserPksRaw) && accountUserPks.length !== accountUserPksRaw.length) {
    console.warn(
      `[storage-audit] session_accountUserPks would change: ${accountUserPksRaw.length} -> ${accountUserPks.length} entry(ies) (duplicate(s) removed)`
    )
  }

  const openWorkspaceKeysRaw = getValue(local, 'session_openWorkspaceKeys')
  let openWorkspaceKeys = toPlainArrayValue('session_openWorkspaceKeys', local, setLocal, issue)
  openWorkspaceKeys = uniqueStrings(openWorkspaceKeys).filter(wsKey => workspaceKeys.includes(wsKey))
  if (Array.isArray(openWorkspaceKeysRaw) && openWorkspaceKeys.length !== openWorkspaceKeysRaw.length) {
    const removed = openWorkspaceKeysRaw.filter(wsKey => !openWorkspaceKeys.includes(wsKey))
    console.warn(
      `[storage-audit] session_openWorkspaceKeys would change: ${openWorkspaceKeysRaw.length} -> ${openWorkspaceKeys.length} entry(ies)` +
      (removed.length > 0 ? ` (stale/duplicate: ${removed.join(', ')})` : '')
    )
  }

  const defaultUserPk = getValue(local, 'session_defaultUserPk')
  if (defaultUserPk !== undefined && (typeof defaultUserPk !== 'string' || !defaultUserPk)) {
    issue('invalid_default_user_pk', 'session_defaultUserPk is invalid', { key: 'session_defaultUserPk' })
    setLocal('session_defaultUserPk', null)
  }

  const referencedAppIds = new Set()
  const referencedAppKeys = new Set()
  const referencedUserPks = new Set()
  const appOwners = new Map()

  if (defaultUserPk && typeof defaultUserPk === 'string') referencedUserPks.add(defaultUserPk)

  for (const wsKey of workspaceKeys) {
    const userPk = getValue(local, `session_workspaceByKey_${wsKey}_userPk`)
    if (typeof userPk !== 'string' || !userPk) {
      issue('workspace_missing_user', 'Workspace has no valid owner', { wsKey })
      plan.removeWorkspaces.push({ wsKey, userPk: null, ownerPubkey: '' })
      continue
    }

    referencedUserPks.add(userPk)
    const ownerPubkey = userPk === defaultUserPk ? '' : toPublicKeyHex(userPk)

    const pinned = toPlainArrayValue(
      `session_workspaceByKey_${wsKey}_pinnedAppIds`,
      local,
      setLocal,
      issue
    )
    let unpinned = toPlainArrayValue(
      `session_workspaceByKey_${wsKey}_unpinnedAppIds`,
      local,
      setLocal,
      issue
    )

    const overlap = new Set(pinned.filter(appId => unpinned.includes(appId)))
    if (overlap.size > 0) {
      issue('app_in_multiple_lists', 'App is present in both pinned and unpinned lists', {
        wsKey,
        appIds: [...overlap]
      })
      unpinned = unpinned.filter(appId => !overlap.has(appId))
      setLocal(`session_workspaceByKey_${wsKey}_unpinnedAppIds`, unpinned)
    }

    const coreAppIds = toPlainObject(getValue(local, `session_workspaceByKey_${wsKey}_unpinnedCoreAppIdsObj`))
    if (isInvalid(local, `session_workspaceByKey_${wsKey}_unpinnedCoreAppIdsObj`) || coreAppIds === null) {
      issue('invalid_core_app_ids', 'Workspace core app registry is invalid', { wsKey })
      setLocal(`session_workspaceByKey_${wsKey}_unpinnedCoreAppIdsObj`, {})
    }

    const appIds = uniqueStrings([...pinned, ...unpinned])
    const validAppKeysByAppId = new Map()
    const invalidInstances = []

    for (const appId of appIds) {
      let appKeys = toPlainArrayValue(
        `session_workspaceByKey_${wsKey}_appById_${appId}_appKeys`,
        local,
        setLocal,
        issue
      )
      appKeys = uniqueStrings(appKeys)
      const validKeys = []

      for (const appKey of appKeys) {
        const storedAppId = getValue(local, `session_appByKey_${appKey}_id`)
        // sessionStorage is per-tab. Missing visibility means this tab has not
        // opened the app yet, so it defaults to closed elsewhere in the app.
        const visibility = getValue(session, `session_appByKey_${appKey}_visibility`) ?? 'closed'
        const route = getValue(local, `session_appByKey_${appKey}_route`)
        const validVisibility = APP_VISIBILITY.has(visibility)
        const validRoute = route === undefined || (typeof route === 'string' && route.length >= 0)

        if (
          typeof storedAppId !== 'string' ||
          storedAppId !== appId ||
          !validVisibility ||
          !validRoute
        ) {
          invalidInstances.push({ wsKey, appId, appKey })
          issue('invalid_app_instance', 'Invalid app instance record', { wsKey, appId, appKey })
          setLocal(`session_appByKey_${appKey}_id`, null)
          setLocal(`session_appByKey_${appKey}_route`, null)
          setSession(`session_appByKey_${appKey}_visibility`, null)
          continue
        }

        validKeys.push(appKey)
        referencedAppKeys.add(appKey)
        validAppKeysByAppId.set(appId, validKeys)
        appOwners.set(appId, ownerPubkey)
      }

      if (appKeys.length !== validKeys.length) {
        setLocal(`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys`, validKeys)
        plan.removeAppInstances.push(...invalidInstances.filter(item => item.appId === appId))
      }

      if (validKeys.length === 0) {
        issue('app_without_instances', 'App has no valid instances', { wsKey, appId })
        setLocal(`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys`, null)
        appOwners.set(appId, ownerPubkey)
        continue
      }

      referencedAppIds.add(appId)
    }

    const remainingAppIds = appIds.filter(appId => (validAppKeysByAppId.get(appId) ?? []).length > 0)
    if (remainingAppIds.length !== appIds.length) {
      setLocal(`session_workspaceByKey_${wsKey}_pinnedAppIds`, pinned.filter(appId => remainingAppIds.includes(appId)))
      setLocal(`session_workspaceByKey_${wsKey}_unpinnedAppIds`, unpinned.filter(appId => remainingAppIds.includes(appId)))
    }

    const openAppKeysKey = `session_workspaceByKey_${wsKey}_openAppKeys`
    const openAppKeys = toPlainArrayValue(
      openAppKeysKey,
      session,
      setSession,
      issue
    )
    // The normalization itself is applied pre-render on every load by
    // normalizeOpenAppKeysInStorage, so it must not be scheduled as a silent
    // session write here (issues: 0 should stay clean). The audit only
    // detects and logs a difference, which is the clue that something keeps
    // corrupting the list. Missing keys are intentionally not logged/written:
    // writing [] for an absent key would be a no-op mutation.
    if (getValue(session, openAppKeysKey) !== undefined) {
      const normalized = normalizeOpenAppKeyList(openAppKeys, {
        referencedAppKeys,
        getLocal: key => getValue(local, key),
        getSession: key => getValue(session, key)
      })
      if (normalized.length !== openAppKeys.length) {
        const removedKeys = openAppKeys.filter(appKey => !normalized.includes(appKey))
        console.warn(
          `[storage-audit] openAppKeys for workspace ${wsKey} would change: ` +
          `${openAppKeys.length} -> ${normalized.length} entry(ies)` +
          (removedKeys.length > 0
            ? ` (stale/duplicate/non-open: ${removedKeys.join(', ')})`
            : '')
        )
      }
    }
  }

  const removedWorkspaceIds = new Set(plan.removeWorkspaces.map(item => item.wsKey))
  const validWorkspaceKeys = workspaceKeys.filter(wsKey => !removedWorkspaceIds.has(wsKey))
  if (validWorkspaceKeys.length !== workspaceKeys.length) {
    setLocal('session_workspaceKeys', validWorkspaceKeys)
    setLocal('session_openWorkspaceKeys', openWorkspaceKeys.filter(wsKey => validWorkspaceKeys.includes(wsKey)))
  }

  for (const appId of [...appOwners.keys()]) {
    if (referencedAppIds.has(appId)) continue
    const ownerPubkey = appOwners.get(appId) || ''
    const existing = plan.removeApps.find(item => item.appId === appId)
    if (!existing) plan.removeApps.push({ appId, ownerPubkey })
  }

  for (const userPk of [...referencedUserPks]) {
    if (userPk === defaultUserPk || accountUserPks.includes(userPk)) continue
    issue('workspace_user_not_in_accounts', 'Workspace owner is not in the account list', { userPk })
    const ownerPubkey = toPublicKeyHex(userPk)
    plan.removeWorkspaces.push(...workspaceKeys.filter(wsKey =>
      getValue(local, `session_workspaceByKey_${wsKey}_userPk`) === userPk
    ).map(wsKey => ({ wsKey, userPk, ownerPubkey })))
  }

  for (const userPk of accountUserPks) {
    const hasWorkspace = validWorkspaceKeys.some(wsKey =>
      getValue(local, `session_workspaceByKey_${wsKey}_userPk`) === userPk
    )
    if (hasWorkspace) continue

    const fields = ACCOUNT_SUFFIXES.map(suffix =>
      getValue(local, `session_accountByUserPk_${userPk}${suffix}`)
    )
    if (fields.some(value => value === undefined)) {
      issue('account_without_workspace_or_data', 'Orphan account entry', { userPk })
      plan.removeAccounts.push({ userPk, ownerPubkey: toPublicKeyHex(userPk) })
    }
  }

  const removedAccountPks = new Set(plan.removeAccounts.map(item => item.userPk))
  if (removedAccountPks.size > 0) {
    const nextAccountUserPks = accountUserPks.filter(userPk => !removedAccountPks.has(userPk))
    if (nextAccountUserPks.length !== accountUserPks.length) {
      setLocal('session_accountUserPks', nextAccountUserPks)
    }
  }

  auditSubdomains(local, plan, issue, setLocal)
  auditOrphanKeys(local, session, {
    plan,
    issue,
    setLocal,
    setSession,
    workspaceKeys: validWorkspaceKeys,
    referencedAppIds,
    referencedAppKeys,
    referencedUserPks,
    accountUserPks,
    manifestAppIds
  })

  return { ok: !hasStorageRepairActions(plan), issues, plan }
}

function toPlainArrayValue (key, snapshot, set, issue) {
  if (isInvalid(snapshot, key)) {
    issue('invalid_array', `${key} must be an array of strings`, { key })
    set(key, [])
    return []
  }
  const raw = getValue(snapshot, key)
  if (raw === undefined) return []
  const value = toPlainStringArray(raw)
  if (value === null) {
    issue('invalid_array', `${key} must be an array of strings`, { key })
    set(key, [])
    return []
  }
  return value
}

function toPlainStringArray (value) {
  if (!Array.isArray(value)) return null
  return value.every(item => typeof item === 'string' && item.length > 0) ? value : null
}

function auditSubdomains (local, plan, issue, setLocal) {
  const nextId = getValue(local, 'session_subdomainNextId')
  if (nextId !== undefined && (!Number.isSafeInteger(nextId) || nextId < 0)) {
    issue('invalid_subdomain_next_id', 'session_subdomainNextId is invalid')
    setLocal('session_subdomainNextId', 0)
  }

  let freeIds = getValue(local, 'session_subdomainFreeIds')
  if (freeIds !== undefined) {
    const normalized = Array.isArray(freeIds)
      ? uniqueStrings(freeIds.filter(id => /^\d+$/.test(String(id))))
      : null
    if (normalized === null || normalized.length !== freeIds.length) {
      issue('invalid_subdomain_free_ids', 'session_subdomainFreeIds is invalid')
      setLocal('session_subdomainFreeIds', normalized ?? [])
      freeIds = normalized ?? []
    }
  } else {
    freeIds = []
  }

  const toAppEntries = new Map()
  const byAppEntries = new Map()
  for (const [key, entry] of local) {
    if (!key.startsWith('session_subdomainToApp_')) continue
    const id = key.slice('session_subdomainToApp_'.length)
    const mapping = entry.value
    if (
      !/^\d+$/.test(id) ||
      !mapping ||
      typeof mapping !== 'object' ||
      typeof mapping.appId !== 'string' ||
      typeof mapping.userPk !== 'string'
    ) {
      issue('invalid_subdomain_mapping', 'Invalid subdomain mapping', { key })
      setLocal(key, null)
      if (/^\d+$/.test(id)) freeIds = uniqueStrings([...freeIds, id]).sort((a, b) => Number(a) - Number(b))
      continue
    }
    toAppEntries.set(id, mapping)
  }

  for (const [key, entry] of local) {
    if (!key.startsWith('session_subdomainByUserAndApp_')) continue
    const rest = key.slice('session_subdomainByUserAndApp_'.length)
    const separator = rest.lastIndexOf('_')
    if (separator <= 0) {
      issue('invalid_subdomain_key', 'Invalid subdomain key', { key })
      setLocal(key, null)
      continue
    }
    const userPk = rest.slice(0, separator)
    const appId = rest.slice(separator + 1)
    const id = String(entry.value ?? '')
    const mapping = toAppEntries.get(id)
    if (!/^\d+$/.test(id) || !mapping || mapping.userPk !== userPk || mapping.appId !== appId) {
      issue('subdomain_mapping_mismatch', 'Subdomain mapping is not bidirectional', { key, id })
      setLocal(key, null)
      if (mapping && mapping.userPk === userPk && mapping.appId === appId) {
        plan.releaseSubdomains.push({ userPk, appId, subdomain: id })
      }
      continue
    }
    byAppEntries.set(`${userPk}\u0000${appId}`, { userPk, appId, subdomain: id })
  }

  for (const [id, mapping] of toAppEntries) {
    if (!byAppEntries.has(`${mapping.userPk}\u0000${mapping.appId}`)) {
      issue('subdomain_mapping_mismatch', 'Subdomain mapping has no reverse entry', { id })
      plan.releaseSubdomains.push({ userPk: mapping.userPk, appId: mapping.appId, subdomain: id })
    }
  }

  if (freeIds.length > 0 && (getValue(local, 'session_subdomainFreeIds') ?? []).join() !== freeIds.join()) {
    setLocal('session_subdomainFreeIds', freeIds)
  }
}

function auditOrphanKeys (local, session, {
  issue,
  setLocal,
  setSession,
  workspaceKeys,
  referencedAppIds,
  referencedAppKeys,
  referencedUserPks,
  accountUserPks,
  manifestAppIds = new Set()
}) {
  const workspaceLocalPrefixes = ['session_workspaceByKey_']
  const appInstanceLocalPrefixes = ['session_appByKey_']
  const appMetadataPrefixes = ['session_appById_']
  const accountPrefixes = ['session_accountByUserPk_']

  for (const [key] of local) {
    if (key.startsWith('session_workspaceByKey_')) {
      const id = extractDynamicId(key, workspaceLocalPrefixes, WORKSPACE_LOCAL_SUFFIXES)
      if (id && !workspaceKeys.includes(id)) {
        issue('orphan_workspace_key', 'Orphan workspace key', { key })
        setLocal(key, null)
      }
      continue
    }
    if (key.startsWith('session_appByKey_')) {
      const appKey = extractDynamicId(key, appInstanceLocalPrefixes, APP_INSTANCE_LOCAL_SUFFIXES)
      if (appKey && !referencedAppKeys.has(appKey)) {
        issue('orphan_app_instance_key', 'Orphan app instance key', { key })
        setLocal(key, null)
      }
      continue
    }
    if (key.startsWith('session_appById_')) {
      const appId = extractDynamicId(key, appMetadataPrefixes, APP_METADATA_SUFFIXES)
      if (
        appId &&
        !referencedAppIds.has(appId) &&
        !hasAnySubdomainForApp(local, appId) &&
        !manifestAppIds.has(appId)
      ) {
        issue('orphan_app_metadata_key', 'Orphan app metadata key', { key })
        setLocal(key, null)
      }
      continue
    }
    if (key.startsWith('session_accountByUserPk_')) {
      const userPk = extractDynamicId(key, accountPrefixes, ACCOUNT_SUFFIXES)
      if (userPk && !referencedUserPks.has(userPk) && !accountUserPks.includes(userPk)) {
        issue('orphan_account_key', 'Orphan account key', { key })
        setLocal(key, null)
      }
    }
  }

  for (const [key] of session) {
    if (key.startsWith('session_workspaceByKey_')) {
      const wsKey = extractDynamicId(key, ['session_workspaceByKey_'], WORKSPACE_SESSION_SUFFIXES)
      if (wsKey && !workspaceKeys.includes(wsKey)) {
        issue('orphan_workspace_session_key', 'Orphan workspace session key', { key })
        setSession(key, null)
      }
    } else if (key.startsWith('session_appByKey_')) {
      const appKey = extractDynamicId(key, ['session_appByKey_'], APP_INSTANCE_SESSION_SUFFIXES)
      if (appKey && !referencedAppKeys.has(appKey)) {
        issue('orphan_app_instance_session_key', 'Orphan app instance session key', { key })
        setSession(key, null)
      }
    }
  }
}

function hasAnySubdomainForApp (local, appId) {
  for (const [key, entry] of local) {
    if (!key.startsWith('session_subdomainByUserAndApp_')) continue
    const rest = key.slice('session_subdomainByUserAndApp_'.length)
    const separator = rest.lastIndexOf('_')
    if (separator > 0 && rest.slice(separator + 1) === appId && entry?.value) return true
  }
  return false
}
