import { validWorkspaceOrder } from '#helpers/active-workspace-order.js'
import { getRandomId } from '#helpers/misc.js'
import { setWebStorageItem } from '#f'

export const CONFIG_STICKY_SESSIONS = 'config_stickySessions'
export const SESSION_STICKY_TAB_ID = 'session_stickyTabId'
export const LOCAL_STICKY_SNAPSHOTS = 'local_stickySessionSnapshots'
export const LOCAL_STICKY_CLAIMS = 'local_stickySessionClaims'
export const LOCAL_STICKY_SEEN_IDS = 'local_stickySessionSeenIds'
export const LOCAL_STICKY_DELETIONS = 'local_stickySessionDeletions'

export const STICKY_SNAPSHOT_DEBOUNCE_MS = 5000
export const STICKY_CLAIM_LEASE_MS = 5 * 60 * 1000
export const STICKY_CLAIM_HEARTBEAT_MS = 60 * 1000
export const STICKY_SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const STICKY_MAX_SNAPSHOTS = 10
export const STICKY_LOCK = 'sticky-session-restore'
export const STICKY_DELETION_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000

const VALID_VISIBILITY = new Set(['open', 'minimized'])

export function readJson (storage, key, fallback = undefined) {
  const raw = storage?.getItem?.(key)
  if (raw == null) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function writeJson (storage, key, value) {
  // setWebStorageItem dispatches a synthetic storage event so same-tab
  // useWebStorage hooks update; null means "remove" in this service.
  setWebStorageItem(storage, key, value === null ? undefined : value)
}

// window.open clones the opener's sessionStorage into the new tab. When a tab
// is opened to restore a specific session, drop the cloned sticky window
// state so hydration starts from a clean slate instead of inheriting the
// opener's session/tab id.
export function resetStickySessionState ({ sessionStorageArea }) {
  if (!sessionStorageArea || typeof sessionStorageArea.length !== 'number' || typeof sessionStorageArea.key !== 'function') {
    return
  }
  sessionStorageArea.removeItem(SESSION_STICKY_TAB_ID)
  sessionStorageArea.removeItem('session_tabWorkspaceKeys')
  for (let index = sessionStorageArea.length - 1; index >= 0; index--) {
    const key = sessionStorageArea.key(index)
    if (typeof key !== 'string') continue
    if (key.startsWith('session_workspaceByKey_') && key.endsWith('_openAppKeys')) {
      sessionStorageArea.removeItem(key)
    } else if (key.startsWith('session_appByKey_') && key.endsWith('_visibility')) {
      sessionStorageArea.removeItem(key)
    }
  }
}

export function isStickySessionsEnabled (localStorageArea = globalThis.localStorage) {
  return readJson(localStorageArea, CONFIG_STICKY_SESSIONS, false) === true
}

export function isSnapshotEmpty (snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return true
  const workspaces = snapshot.workspaces
  if (!workspaces || typeof workspaces !== 'object') return true
  return Object.values(workspaces).every(ws =>
    !ws ||
    (
      (!Array.isArray(ws.openKeys) || ws.openKeys.length === 0) &&
      (!Array.isArray(ws.minimizedKeys) || ws.minimizedKeys.length === 0)
    )
  )
}

// Builds a snapshot payload from a live-tab draft. `updatedAt` is stamped at
// commit time, not here, so the draft can be diffed/merged without churn.
export function buildSnapshotFromDraft ({ workspaceKeys, byWorkspace }) {
  const workspaces = {}
  const order = Array.isArray(workspaceKeys) ? workspaceKeys : []
  for (const wsKey of order) {
    const ws = byWorkspace?.[wsKey]
    const openKeys = Array.isArray(ws?.openKeys) ? ws.openKeys : []
    const minimizedKeys = Array.isArray(ws?.minimizedKeys) ? ws.minimizedKeys : []
    const rawVisibility = ws?.visibility ?? {}
    const validOpen = openKeys.filter(key => rawVisibility[key] === 'open')
    const validMinimized = [...new Set([
      ...minimizedKeys.filter(key => rawVisibility[key] === 'minimized'),
      ...openKeys.filter(key => rawVisibility[key] === 'minimized')
    ])]
    if (validOpen.length > 0 || validMinimized.length > 0) {
      workspaces[wsKey] = { openKeys: validOpen, minimizedKeys: validMinimized }
    }
  }
  return { workspaceKeys: order, workspaces }
}

export function isClaimActive (claim, now = Date.now()) {
  return Boolean(
    claim &&
    typeof claim.tabId === 'string' &&
    Number.isFinite(claim.claimedAt) &&
    now - claim.claimedAt < STICKY_CLAIM_LEASE_MS
  )
}

// Collects appKeys that still exist for a workspace: the key must appear in
// one of `session_workspaceByKey_<wsKey>_appById_<appId>_appKeys` lists and
// have a string `session_appByKey_<key>_id`.
export function collectValidAppKeys (localStorageArea, wsKey) {
  const valid = new Set()
  if (!localStorageArea || typeof localStorageArea.length !== 'number' || typeof localStorageArea.key !== 'function') {
    return valid
  }
  const prefix = `session_workspaceByKey_${wsKey}_appById_`
  const suffix = '_appKeys'
  for (let index = 0; index < localStorageArea.length; index++) {
    const key = localStorageArea.key(index)
    if (typeof key !== 'string' || !key.startsWith(prefix) || !key.endsWith(suffix)) continue
    const appKeys = readJson(localStorageArea, key, [])
    if (!Array.isArray(appKeys)) continue
    for (const appKey of appKeys) {
      if (typeof appKey !== 'string') continue
      if (typeof readJson(localStorageArea, `session_appByKey_${appKey}_id`) === 'string') {
        valid.add(appKey)
      }
    }
  }
  return valid
}

export function validateAndCleanSnapshot (snapshot, {
  localStorageArea,
  workspaceKeys
}) {
  const cleaned = {
    workspaceKeys: validWorkspaceOrder(snapshot?.workspaceKeys, workspaceKeys),
    workspaces: {}
  }
  const droppedKeys = []

  for (const [wsKey, ws] of Object.entries(snapshot?.workspaces ?? {})) {
    if (!workspaceKeys.includes(wsKey)) continue
    const validKeys = collectValidAppKeys(localStorageArea, wsKey)
    const openKeys = Array.isArray(ws?.openKeys) ? ws.openKeys : []
    const minimizedKeys = Array.isArray(ws?.minimizedKeys) ? ws.minimizedKeys : []
    const allKeys = [...new Set([...openKeys, ...minimizedKeys])]
    const classified = {}
    for (const appKey of allKeys) {
      const value = minimizedKeys.includes(appKey) ? 'minimized' : 'open'
      if (!validKeys.has(appKey) || !VALID_VISIBILITY.has(value)) {
        droppedKeys.push(appKey)
        continue
      }
      classified[appKey] = value
    }
    const validOpen = allKeys.filter(key => classified[key] === 'open')
    const validMinimized = allKeys.filter(key => classified[key] === 'minimized')
    if (validOpen.length > 0 || validMinimized.length > 0) {
      cleaned.workspaces[wsKey] = { openKeys: validOpen, minimizedKeys: validMinimized }
    }
  }

  return { cleaned, droppedKeys }
}

// Writes a validated snapshot into sessionStorage (tab workspace order,
// openAppKeys and visibility per workspace). Returns the cleaned snapshot so
// the caller can persist it back.
export function hydrateSnapshot (snapshot, {
  localStorageArea,
  sessionStorageArea,
  workspaceKeys
}) {
  const { cleaned, droppedKeys } = validateAndCleanSnapshot(snapshot, {
    localStorageArea,
    workspaceKeys
  })

  if (cleaned.workspaceKeys.length > 0) {
    writeJson(sessionStorageArea, 'session_tabWorkspaceKeys', cleaned.workspaceKeys)
  }
  for (const [wsKey, ws] of Object.entries(cleaned.workspaces)) {
    writeJson(sessionStorageArea, `session_workspaceByKey_${wsKey}_openAppKeys`, ws.openKeys)
    for (const appKey of ws.openKeys) {
      writeJson(sessionStorageArea, `session_appByKey_${appKey}_visibility`, 'open')
    }
    for (const appKey of ws.minimizedKeys) {
      writeJson(sessionStorageArea, `session_appByKey_${appKey}_visibility`, 'minimized')
    }
  }

  return { cleaned, droppedKeys }
}

// Orders a session's workspace apps like the toolbar app list: pinned apps
// first, then unpinned, respecting the stored instance order within each app.
// Returns one group per app with the number of open/minimized instances.
export function listSessionWorkspaceAppGroups ({
  localStorageArea,
  wsKey,
  openKeys = [],
  minimizedKeys = []
}) {
  const snapshotKeys = new Set([...(openKeys || []), ...(minimizedKeys || [])])
  const orderedAppIds = []
  for (const appId of readJson(localStorageArea, `session_workspaceByKey_${wsKey}_pinnedAppIds`, []) ?? []) {
    if (typeof appId === 'string' && !orderedAppIds.includes(appId)) orderedAppIds.push(appId)
  }
  for (const appId of readJson(localStorageArea, `session_workspaceByKey_${wsKey}_unpinnedAppIds`, []) ?? []) {
    if (typeof appId === 'string' && !orderedAppIds.includes(appId)) orderedAppIds.push(appId)
  }

  const groups = []
  for (const appId of orderedAppIds) {
    const appKeys = readJson(localStorageArea, `session_workspaceByKey_${wsKey}_appById_${appId}_appKeys`, [])
    const keysInSession = (Array.isArray(appKeys) ? appKeys : []).filter(key => snapshotKeys.has(key))
    if (keysInSession.length === 0) continue
    const openCount = keysInSession.filter(key => (openKeys || []).includes(key)).length
    groups.push({
      appId,
      openCount,
      minimizedCount: keysInSession.length - openCount
    })
  }
  return groups
}

export function gcStickySessions ({
  localStorageArea,
  now = Date.now()
}) {
  const snapshots = readJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, {})
  const claims = readJson(localStorageArea, LOCAL_STICKY_CLAIMS, {})
  const seenIds = readJson(localStorageArea, LOCAL_STICKY_SEEN_IDS, [])
  const deletions = readJson(localStorageArea, LOCAL_STICKY_DELETIONS, {})
  const removedSnapshots = []
  const removedClaims = []
  const removedDeletions = []

  if (snapshots && typeof snapshots === 'object' && !Array.isArray(snapshots)) {
    for (const [id, snapshot] of Object.entries(snapshots)) {
      if (!snapshot || !Number.isFinite(snapshot.updatedAt) || now - snapshot.updatedAt >= STICKY_SNAPSHOT_TTL_MS) {
        delete snapshots[id]
        removedSnapshots.push(id)
      }
    }
  }

  if (claims && typeof claims === 'object' && !Array.isArray(claims)) {
    for (const [id, claim] of Object.entries(claims)) {
      if (!isClaimActive(claim, now)) {
        delete claims[id]
        removedClaims.push(id)
      }
    }
  }

  if (deletions && typeof deletions === 'object' && !Array.isArray(deletions)) {
    for (const [id, deletedAt] of Object.entries(deletions)) {
      if (!Number.isFinite(deletedAt) || now - deletedAt >= STICKY_DELETION_TOMBSTONE_TTL_MS) {
        delete deletions[id]
        removedDeletions.push(id)
      }
    }
  }

  const remainingIds = Object.keys(snapshots).sort((a, b) =>
    (snapshots[b]?.updatedAt ?? 0) - (snapshots[a]?.updatedAt ?? 0)
  )
  const overflow = remainingIds.slice(STICKY_MAX_SNAPSHOTS)
  for (const id of overflow) {
    delete snapshots[id]
    removedSnapshots.push(id)
  }

  const nextSeen = (Array.isArray(seenIds) ? seenIds : []).filter(id =>
    Object.prototype.hasOwnProperty.call(snapshots, id)
  )

  writeJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, Object.keys(snapshots).length ? snapshots : null)
  writeJson(localStorageArea, LOCAL_STICKY_CLAIMS, Object.keys(claims).length ? claims : null)
  writeJson(localStorageArea, LOCAL_STICKY_SEEN_IDS, nextSeen.length ? nextSeen : null)
  writeJson(localStorageArea, LOCAL_STICKY_DELETIONS, Object.keys(deletions).length ? deletions : null)

  return { removedSnapshots, removedClaims, removedDeletions }
}

export function pickSnapshotToRestore ({
  localStorageArea,
  requestedSnapshotId = null,
  now = Date.now()
}) {
  const snapshots = readJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, {})
  const claims = readJson(localStorageArea, LOCAL_STICKY_CLAIMS, {})
  if (requestedSnapshotId) {
    return Object.prototype.hasOwnProperty.call(snapshots, requestedSnapshotId)
      ? requestedSnapshotId
      : null
  }
  const candidates = Object.keys(snapshots)
    .filter(id => !isClaimActive(claims?.[id], now))
    .sort((a, b) => (snapshots[a]?.updatedAt ?? 0) - (snapshots[b]?.updatedAt ?? 0))
  return candidates[0] || null
}

// Claims a snapshot (oldest unclaimed, or the requested one), re-keys it to
// this tab's id, hydrates sessionStorage and registers the claim lease.
export async function claimAndHydrateStickySession ({
  localStorageArea,
  sessionStorageArea,
  navigatorArea = globalThis.navigator,
  tabId,
  requestedSnapshotId = null,
  resetClonedState = false,
  workspaceKeys,
  now = Date.now(),
  log = console
}) {
  const task = async () => {
    gcStickySessions({ localStorageArea, now })
    const snapshotId = pickSnapshotToRestore({
      localStorageArea,
      requestedSnapshotId,
      now
    })
    if (!snapshotId) {
      if (requestedSnapshotId) {
        log.warn(
          `[sticky-sessions] Requested snapshot ${requestedSnapshotId} not found; skipping restore`
        )
      }
      return { hydrated: false, reason: 'none' }
    }

    // A tab opened via window.open inherits the opener's sessionStorage
    // (including its sticky tab id). When a specific session was requested,
    // drop the clone inside the lock and only after confirming the snapshot
    // still exists, so a losing tab in a double-restore race keeps its
    // cloned state instead of being wiped by a restore it did not win.
    if (resetClonedState) {
      resetStickySessionState({ sessionStorageArea })
    }

    const snapshots = readJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, {})
    const snapshot = snapshots[snapshotId]
    if (!snapshot) return { hydrated: false, reason: 'missing' }

    const { cleaned, droppedKeys } = hydrateSnapshot(snapshot, {
      localStorageArea,
      sessionStorageArea,
      workspaceKeys
    })
    if (droppedKeys.length > 0) {
      log.warn(
        `[sticky-sessions] Snapshot ${snapshotId} descartou ${droppedKeys.length} app(s) não instalado(s): ${droppedKeys.join(', ')}`
      )
    }

    delete snapshots[snapshotId]
    if (!isSnapshotEmpty(cleaned)) {
      snapshots[tabId] = { ...cleaned, updatedAt: snapshot.updatedAt }
    }
    writeJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, Object.keys(snapshots).length ? snapshots : null)

    const claims = readJson(localStorageArea, LOCAL_STICKY_CLAIMS, {})
    delete claims[snapshotId]
    if (!isSnapshotEmpty(cleaned)) {
      claims[tabId] = { tabId, claimedAt: now }
    }
    writeJson(localStorageArea, LOCAL_STICKY_CLAIMS, Object.keys(claims).length ? claims : null)

    writeJson(sessionStorageArea, SESSION_STICKY_TAB_ID, tabId)
    return { hydrated: true, snapshotId: tabId, dropped: droppedKeys }
  }

  const locks = navigatorArea?.locks
  if (!locks || typeof locks.request !== 'function') return task()
  return locks.request(STICKY_LOCK, task)
}

export function commitStickySnapshot ({
  localStorageArea,
  tabId,
  snapshot,
  now = Date.now()
}) {
  const snapshots = readJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, {})
  if (isSnapshotEmpty(snapshot)) {
    delete snapshots[tabId]
    writeJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, Object.keys(snapshots).length ? snapshots : null)
    const claims = readJson(localStorageArea, LOCAL_STICKY_CLAIMS, {})
    delete claims[tabId]
    writeJson(localStorageArea, LOCAL_STICKY_CLAIMS, Object.keys(claims).length ? claims : null)
    return { committed: false }
  }

  snapshots[tabId] = { ...snapshot, updatedAt: now }
  writeJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, snapshots)
  const claims = readJson(localStorageArea, LOCAL_STICKY_CLAIMS, {})
  if (!isClaimActive(claims[tabId], now)) {
    claims[tabId] = { tabId, claimedAt: now }
  }
  writeJson(localStorageArea, LOCAL_STICKY_CLAIMS, claims)
  return { committed: true }
}

export function heartbeatStickyClaim ({
  localStorageArea,
  tabId,
  now = Date.now()
}) {
  const claims = readJson(localStorageArea, LOCAL_STICKY_CLAIMS, {})
  if (!claims[tabId]) {
    // Re-assert an expired/lost lease for this tab's own snapshot, so a
    // frozen background tab does not permanently lose its claim.
    const snapshots = readJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, {})
    const own = snapshots[tabId]
    if (!own || isSnapshotEmpty(own)) return false
  }
  claims[tabId] = { tabId, claimedAt: now }
  writeJson(localStorageArea, LOCAL_STICKY_CLAIMS, claims)
  return true
}

export function releaseStickyClaim ({ localStorageArea, tabId }) {
  const claims = readJson(localStorageArea, LOCAL_STICKY_CLAIMS, {})
  if (claims[tabId]) {
    delete claims[tabId]
    writeJson(localStorageArea, LOCAL_STICKY_CLAIMS, Object.keys(claims).length ? claims : null)
    return true
  }
  return false
}

export function removeStickySession ({ localStorageArea, snapshotId }) {
  const snapshots = readJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, {})
  const claims = readJson(localStorageArea, LOCAL_STICKY_CLAIMS, {})
  const seenIds = readJson(localStorageArea, LOCAL_STICKY_SEEN_IDS, [])
  const removed = Object.prototype.hasOwnProperty.call(snapshots, snapshotId)
  delete snapshots[snapshotId]
  delete claims[snapshotId]
  const nextSeen = (Array.isArray(seenIds) ? seenIds : []).filter(id => id !== snapshotId)
  writeJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, Object.keys(snapshots).length ? snapshots : null)
  writeJson(localStorageArea, LOCAL_STICKY_CLAIMS, Object.keys(claims).length ? claims : null)
  writeJson(localStorageArea, LOCAL_STICKY_SEEN_IDS, nextSeen.length ? nextSeen : null)
  return removed
}

// Copies a saved session under a fresh snapshot id (no claim), so a new tab
// can be opened from it without taking over the original session.
export function duplicateStickySession ({
  localStorageArea,
  snapshotId,
  now = Date.now(),
  newSnapshotId = getRandomId()
}) {
  const snapshots = readJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, {})
  const source = snapshots[snapshotId]
  if (!source) return null
  snapshots[newSnapshotId] = {
    updatedAt: now,
    workspaceKeys: Array.isArray(source.workspaceKeys) ? [...source.workspaceKeys] : [],
    workspaces: JSON.parse(JSON.stringify(source.workspaces ?? {}))
  }
  writeJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, snapshots)
  return newSnapshotId
}

export function purgeStickySessions ({ localStorageArea }) {
  writeJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, null)
  writeJson(localStorageArea, LOCAL_STICKY_CLAIMS, null)
  writeJson(localStorageArea, LOCAL_STICKY_SEEN_IDS, null)
  writeJson(localStorageArea, LOCAL_STICKY_DELETIONS, null)
}

// Deletes a session from the list. When the session is currently claimed by
// a live tab, a tombstone is left so that tab closes all of its app
// instances; the tombstone is removed when the tab acknowledges.
export function requestStickySessionDelete ({
  localStorageArea,
  snapshotId,
  now = Date.now()
}) {
  const snapshots = readJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, {})
  if (!Object.prototype.hasOwnProperty.call(snapshots, snapshotId)) return false

  const claims = readJson(localStorageArea, LOCAL_STICKY_CLAIMS, {})
  if (isClaimActive(claims?.[snapshotId], now)) {
    const deletions = readJson(localStorageArea, LOCAL_STICKY_DELETIONS, {})
    deletions[snapshotId] = now
    writeJson(localStorageArea, LOCAL_STICKY_DELETIONS, deletions)
  }

  removeStickySession({ localStorageArea, snapshotId })
  return true
}

export function ackStickySessionDeletion ({ localStorageArea, snapshotId }) {
  const deletions = readJson(localStorageArea, LOCAL_STICKY_DELETIONS, {})
  if (!deletions[snapshotId]) return false
  delete deletions[snapshotId]
  writeJson(localStorageArea, LOCAL_STICKY_DELETIONS, Object.keys(deletions).length ? deletions : null)
  return true
}

export function markStickySessionsSeen ({ localStorageArea, now = Date.now() }) {
  const snapshots = readJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, {})
  const claims = readJson(localStorageArea, LOCAL_STICKY_CLAIMS, {})
  const seenIds = readJson(localStorageArea, LOCAL_STICKY_SEEN_IDS, [])
  const unclaimed = Object.keys(snapshots).filter(id => !isClaimActive(claims?.[id], now))
  const nextSeen = [...new Set([...(Array.isArray(seenIds) ? seenIds : []), ...unclaimed])]
  writeJson(localStorageArea, LOCAL_STICKY_SEEN_IDS, nextSeen.length ? nextSeen : null)
  return nextSeen
}

export function unseenUnclaimedCount ({
  snapshots,
  claims,
  seenIds,
  now = Date.now()
}) {
  const snapshotMap = snapshots && typeof snapshots === 'object' && !Array.isArray(snapshots) ? snapshots : {}
  const claimMap = claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : {}
  const seen = Array.isArray(seenIds) ? seenIds : []
  return Object.keys(snapshotMap)
    .filter(id => !isClaimActive(claimMap[id], now) && !seen.includes(id))
    .length
}

export function readStickySessionsList ({ localStorageArea, now = Date.now() }) {
  const snapshots = readJson(localStorageArea, LOCAL_STICKY_SNAPSHOTS, {})
  const claims = readJson(localStorageArea, LOCAL_STICKY_CLAIMS, {})
  return Object.entries(snapshots)
    .map(([id, snapshot]) => ({
      id,
      updatedAt: snapshot?.updatedAt ?? 0,
      workspaceKeys: Array.isArray(snapshot?.workspaceKeys) ? snapshot.workspaceKeys : [],
      workspaces: snapshot?.workspaces ?? {},
      claimed: isClaimActive(claims?.[id], now)
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
