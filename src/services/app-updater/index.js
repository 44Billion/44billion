import AppFileDownloader from '#services/app-file-downloader/index.js'
import { relayPool as nostrRelays } from 'libp2r2p/relay'
import { nappRelays } from '#config/relays.js'
import {
  getSiteManifestFromDb,
  listSiteManifestsFromDb,
  normalizeSingleNappOpenedAtByOwner,
  saveSiteManifestToDb
} from '#services/idb/browser/queries/site-manifest.js'
import { deleteStaleFileChunksFromDb, sumFileChunkBytesFromDb } from '#services/idb/browser/queries/file-chunk.js'
import { addressObjToAppId, appIdToAddressObj } from '#helpers/app.js'
import { getManifestAssetDescriptors } from '#helpers/site-manifest.js'
import { base62ToBase16 } from 'libp2r2p/base62'
import { getUserRelays } from '#helpers/nostr-queries.js'
import { cleanupNostrDbAppForOwner as cleanupNostrDbAppForOwnerBase } from '#helpers/nostrdb-app-cleanup.js'
import { addSubdomainFreeId } from '#helpers/subdomain-mapping.js'
import { setWebStorageItem } from '#helpers/web-storage.js'
import { removeVaultAcceptedMessage } from '#helpers/window-message/browser/vault-accepted-message-queue.js'
import { jsVars } from '#assets/styles/theme.js'

const HEX_PUBKEY = /^[0-9a-f]{64}$/i
const SINGLE_NAPP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const SINGLE_NAPP_OPEN_COUNTS_KEY = 'session_singleNappOpenAppCounts'
const EMBEDDED_RETENTION_ADMISSIONS_KEY = 'local_embeddedOnlyRetentionAdmissions'
const ONE_HOUR_MS = 60 * 60 * 1000
const DRAFT_SITE_MANIFEST_KIND = 35130
const DRAFT_UPDATE_WATCH_INTERVAL_MS = 5000
const DRAFT_UPDATE_PENDING_RETRY_MS = 30000

export const MAX_RETAINED_EMBEDDED_APPS = 50
export const MAX_NEW_RETAINED_EMBEDDED_APPS_PER_HOUR = 10
export const MAX_ACTIVE_EMBEDDED_APPS = 50

function defaultGetNostrDb (ownerPubkey) {
  return {
    async deleteEventsByApp (appId) {
      const { getNostrDb } = await import('#services/idb/nostrdb/index.js')
      return getNostrDb(ownerPubkey).deleteEventsByApp(appId)
    }
  }
}

export default class AppUpdater {
  static _pendingSearches = new Map()
  static _draftUpdateListeners = new Set()
  static _draftPendingEvents = new Map()
  static _draftApplyingAppIds = new Set()
  static _draftWatchStop = null
  // Set to true while the user is on the app updates page so the unread
  // indicator stays hidden even if a background check finds new updates.
  static isUserViewingUpdates = false

  // Cap on concurrent app updates across all entry points (auto + manual).
  // Tunable: bump this to allow more parallel downloads.
  static MAX_CONCURRENT_UPDATES = 1
  static _activeUpdates = 0
  static _updateQueue = []

  static async _acquireUpdateSlot () {
    while (this._activeUpdates >= this.MAX_CONCURRENT_UPDATES) {
      await new Promise(resolve => this._updateQueue.push(resolve))
    }
    this._activeUpdates++
  }

  static _releaseUpdateSlot () {
    this._activeUpdates--
    const next = this._updateQueue.shift()
    if (next) next()
  }

  static getInstalledAppIds ({ _localStorage } = {}) {
    const storage = _localStorage || localStorage
    const workspaceKeys = JSON.parse(storage.getItem('session_workspaceKeys') || '[]')
    const appIds = new Set()

    workspaceKeys.forEach(wsKey => {
      const pinned = JSON.parse(storage.getItem(`session_workspaceByKey_${wsKey}_pinnedAppIds`) || '[]')
      const unpinned = JSON.parse(storage.getItem(`session_workspaceByKey_${wsKey}_unpinnedAppIds`) || '[]')
      pinned.forEach(id => appIds.add(id))
      unpinned.forEach(id => appIds.add(id))
    })

    return Array.from(appIds)
  }

  static isDraftAppId (appId, { _appIdToAddressObj = appIdToAddressObj } = {}) {
    try {
      return _appIdToAddressObj(appId).kind === DRAFT_SITE_MANIFEST_KIND
    } catch (_err) {
      return false
    }
  }

  static filterRegularAppIds (appIds, deps = {}) {
    return (appIds || []).filter(appId => !this.isDraftAppId(appId, deps))
  }

  static filterDraftAppIds (appIds, deps = {}) {
    return (appIds || []).filter(appId => this.isDraftAppId(appId, deps))
  }

  static getInstalledDraftAppIds (deps = {}) {
    return this.filterDraftAppIds(this.getInstalledAppIds(deps), deps)
  }

  static _readJsonStorage (storage, key, fallback) {
    try {
      const raw = storage?.getItem?.(key)
      return raw == null ? fallback : JSON.parse(raw)
    } catch {
      return fallback
    }
  }

  static _writeJsonStorage (storage, key, value) {
    if (!storage) return
    if (value === undefined) storage.removeItem?.(key)
    else storage.setItem?.(key, JSON.stringify(value))
  }

  static getInstalledOwnerPubkeysForApp (appId, { _localStorage } = {}) {
    const storage = _localStorage || (typeof localStorage !== 'undefined' ? localStorage : null)
    if (!storage || !appId) return new Set()

    const defaultUserPk = this._readJsonStorage(storage, 'session_defaultUserPk', null)
    const workspaceKeys = this._readJsonStorage(storage, 'session_workspaceKeys', [])
    const owners = new Set()

    for (const wsKey of workspaceKeys) {
      const pinned = this._readJsonStorage(storage, `session_workspaceByKey_${wsKey}_pinnedAppIds`, [])
      const unpinned = this._readJsonStorage(storage, `session_workspaceByKey_${wsKey}_unpinnedAppIds`, [])
      if (!pinned.includes(appId) && !unpinned.includes(appId)) continue

      const userPk = this._readJsonStorage(storage, `session_workspaceByKey_${wsKey}_userPk`, null)
      if (!userPk || userPk === defaultUserPk) continue

      try {
        const owner = base62ToBase16(userPk, { mode: 'integer', byteLength: 32 }).toLowerCase()
        if (HEX_PUBKEY.test(owner)) owners.add(owner)
      } catch (_err) {
        continue
      }
    }

    return owners
  }

  static async getCleanupAppIds ({
    _localStorage,
    _listSiteManifestsFromDb = listSiteManifestsFromDb,
    _addressObjToAppId = addressObjToAppId
  } = {}) {
    const appIds = new Set(this.getInstalledAppIds({ _localStorage }))
    for (const manifest of await _listSiteManifestsFromDb()) {
      const dTag = manifest.tags.find(t => t[0] === 'd')?.[1] ?? ''
      try {
        appIds.add(_addressObjToAppId({
          kind: manifest.kind,
          pubkey: manifest.pubkey,
          dTag
        }))
      } catch (_err) {
        continue
      }
    }
    return Array.from(appIds)
  }

  static async getEmbeddedOnlyAppIds ({
    _localStorage,
    _listSiteManifestsFromDb = listSiteManifestsFromDb,
    _addressObjToAppId = addressObjToAppId,
    _now = Date.now,
    singleNappRetentionMs = SINGLE_NAPP_RETENTION_MS
  } = {}) {
    const installedAppIds = new Set(this.getInstalledAppIds({ _localStorage }))
    const embeddedAppIds = new Set()
    const now = _now()

    for (const manifest of await _listSiteManifestsFromDb()) {
      const { recent } = this.partitionSingleNappOwners(
        manifest.meta?.singleNappOpenedAtByOwner,
        { now, retentionMs: singleNappRetentionMs }
      )
      if (Object.keys(recent).length === 0) continue

      const dTag = manifest.tags.find(t => t[0] === 'd')?.[1] ?? ''
      try {
        const appId = _addressObjToAppId({
          kind: manifest.kind,
          pubkey: manifest.pubkey,
          dTag
        })
        if (manifest.kind === DRAFT_SITE_MANIFEST_KIND) continue
        if (!installedAppIds.has(appId)) embeddedAppIds.add(appId)
      } catch (_err) {
        continue
      }
    }

    return Array.from(embeddedAppIds)
  }

  static partitionSingleNappOwners (singleNappOpenedAtByOwner, {
    now = Date.now(),
    retentionMs = SINGLE_NAPP_RETENTION_MS
  } = {}) {
    const owners = normalizeSingleNappOpenedAtByOwner(singleNappOpenedAtByOwner)
    const cutoff = now - retentionMs
    const recent = {}
    const stale = []

    for (const [owner, openedAt] of Object.entries(owners)) {
      if (openedAt >= cutoff) recent[owner] = openedAt
      else stale.push(owner)
    }

    return {
      recent,
      stale,
      changed: Object.keys(recent).length !== Object.keys(owners).length
    }
  }

  static async cleanupOwnerAppData (ownerPubkey, appId, {
    _getNostrDb = defaultGetNostrDb,
    _getSiteManifestFromDb = getSiteManifestFromDb,
    _saveSiteManifestToDb = saveSiteManifestToDb,
    _removeVaultAcceptedMessage = removeVaultAcceptedMessage,
    _updateSingleNappManifest = true
  } = {}) {
    return cleanupNostrDbAppForOwnerBase({
      ownerPubkey,
      appId,
      getNostrDb: _getNostrDb,
      getSiteManifestFromDb: _getSiteManifestFromDb,
      saveSiteManifestToDb: _saveSiteManifestToDb,
      removeAcceptedMessage: _removeVaultAcceptedMessage,
      updateSingleNappManifest: _updateSingleNappManifest,
      logPrefix: 'Failed to clean up stale single-napp app data'
    })
  }

  static clearCachedAppMetadata (appId, {
    _localStorage,
    _setWebStorageItem = setWebStorageItem
  } = {}) {
    const storage = _localStorage || (typeof localStorage !== 'undefined' ? localStorage : null)
    if (!storage || !appId) return
    for (const key of ['icon', 'name', 'description', 'relayHints']) {
      _setWebStorageItem(storage, `session_appById_${appId}_${key}`, undefined)
    }
  }

  static _storageKeys (storage) {
    if (!storage) return []
    if (typeof storage.length === 'number' && typeof storage.key === 'function') {
      const keys = []
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (key != null) keys.push(key)
      }
      return keys
    }
    return []
  }

  static removeSubdomainMappingsForApp (appId, {
    _localStorage,
    _setWebStorageItem = setWebStorageItem
  } = {}) {
    const storage = _localStorage || (typeof localStorage !== 'undefined' ? localStorage : null)
    if (!storage || !appId) return 0

    let removed = 0
    const prefix = 'session_subdomainByUserAndApp_'
    const suffix = `_${appId}`
    for (const key of this._storageKeys(storage)) {
      if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
      const subdomain = this._readJsonStorage(storage, key, null)
      _setWebStorageItem(storage, key, undefined)
      removed++
      if (subdomain != null) {
        _setWebStorageItem(storage, `session_subdomainToApp_${subdomain}`, undefined)
        const freeIds = addSubdomainFreeId(
          this._readJsonStorage(storage, 'session_subdomainFreeIds', []),
          subdomain
        )
        _setWebStorageItem(storage, 'session_subdomainFreeIds', freeIds.length ? freeIds : undefined)
      }
    }
    return removed
  }

  static _embeddedRetentionAdmissions ({
    _localStorage,
    _now = Date.now,
    intervalMs = ONE_HOUR_MS
  } = {}) {
    const storage = _localStorage || (typeof localStorage !== 'undefined' ? localStorage : null)
    const now = _now()
    const cutoff = now - intervalMs
    const raw = this._readJsonStorage(storage, EMBEDDED_RETENTION_ADMISSIONS_KEY, [])
    const admissions = []

    if (Array.isArray(raw)) {
      for (const item of raw) {
        const appId = typeof item?.appId === 'string' ? item.appId : ''
        const at = Number(item?.at)
        if (!appId || !Number.isFinite(at) || at < cutoff || at > now) continue
        admissions.push({ appId, at })
      }
    }

    return { storage, now, admissions }
  }

  static _writeEmbeddedRetentionAdmissions (storage, admissions) {
    this._writeJsonStorage(
      storage,
      EMBEDDED_RETENTION_ADMISSIONS_KEY,
      admissions.length ? admissions : undefined
    )
  }

  static _latestSingleNappOpenedAt (singleNappOpenedAtByOwner) {
    const owners = normalizeSingleNappOpenedAtByOwner(singleNappOpenedAtByOwner)
    let latest = 0
    for (const openedAt of Object.values(owners)) latest = Math.max(latest, openedAt)
    return latest
  }

  static async _embeddedRetentionEntries ({
    _localStorage,
    _listSiteManifestsFromDb = listSiteManifestsFromDb,
    _addressObjToAppId = addressObjToAppId,
    _now = Date.now,
    singleNappRetentionMs = SINGLE_NAPP_RETENTION_MS
  } = {}) {
    const installedAppIds = new Set(this.getInstalledAppIds({ _localStorage }))
    const now = _now()
    const entries = []

    for (const manifest of await _listSiteManifestsFromDb()) {
      const { recent } = this.partitionSingleNappOwners(
        manifest.meta?.singleNappOpenedAtByOwner,
        { now, retentionMs: singleNappRetentionMs }
      )
      if (Object.keys(recent).length === 0) continue

      const dTag = manifest.tags.find(t => t[0] === 'd')?.[1] ?? ''
      try {
        const appId = _addressObjToAppId({
          kind: manifest.kind,
          pubkey: manifest.pubkey,
          dTag
        })
        if (installedAppIds.has(appId)) continue
        entries.push({
          appId,
          manifest,
          openedAt: this._latestSingleNappOpenedAt(recent)
        })
      } catch (_err) {
        continue
      }
    }

    return entries
  }

  static async evictEmbeddedOnlyApp (appId, manifest, {
    _localStorage,
    _getNostrDb = defaultGetNostrDb,
    _getSiteManifestFromDb = getSiteManifestFromDb,
    _saveSiteManifestToDb = saveSiteManifestToDb,
    _clearCachedFilesById = async appId => (await import('#services/app-file-manager/index.js')).default.clearCachedFilesById(appId),
    _removeVaultAcceptedMessage = removeVaultAcceptedMessage,
    _setWebStorageItem = setWebStorageItem
  } = {}) {
    const owners = normalizeSingleNappOpenedAtByOwner(manifest?.meta?.singleNappOpenedAtByOwner)
    for (const ownerPubkey of Object.keys(owners)) {
      await this.cleanupOwnerAppData(ownerPubkey, appId, {
        _getNostrDb,
        _getSiteManifestFromDb,
        _saveSiteManifestToDb,
        _removeVaultAcceptedMessage,
        _updateSingleNappManifest: false
      })
    }

    await _clearCachedFilesById(appId)
    this.clearCachedAppMetadata(appId, { _localStorage, _setWebStorageItem })
    this.removeSubdomainMappingsForApp(appId, { _localStorage, _setWebStorageItem })

    const { storage, admissions } = this._embeddedRetentionAdmissions({ _localStorage })
    const remaining = admissions.filter(item => item.appId !== appId)
    if (remaining.length !== admissions.length) {
      this._writeEmbeddedRetentionAdmissions(storage, remaining)
    }
  }

  static async enforceEmbeddedOnlyRetentionLimit ({
    maxRetained = MAX_RETAINED_EMBEDDED_APPS,
    ...deps
  } = {}) {
    if (!Number.isFinite(maxRetained) || maxRetained < 0) return []

    const entries = await this._embeddedRetentionEntries(deps)
    if (entries.length <= maxRetained) return []

    entries.sort((a, b) => a.openedAt - b.openedAt || a.appId.localeCompare(b.appId))
    const evicted = []
    for (const entry of entries.slice(0, entries.length - maxRetained)) {
      await this.evictEmbeddedOnlyApp(entry.appId, entry.manifest, deps)
      evicted.push(entry.appId)
    }
    return evicted
  }

  static async recordEmbeddedOnlyRetention ({
    appId,
    ownerPubkey,
    siteManifest,
    updateSiteManifestMetadata,
    _localStorage,
    _listSiteManifestsFromDb = listSiteManifestsFromDb,
    _addressObjToAppId = addressObjToAppId,
    _now = Date.now,
    singleNappRetentionMs = SINGLE_NAPP_RETENTION_MS,
    maxRetained = MAX_RETAINED_EMBEDDED_APPS,
    maxNewPerHour = MAX_NEW_RETAINED_EMBEDDED_APPS_PER_HOUR,
    ...cleanupDeps
  } = {}) {
    const owner = typeof ownerPubkey === 'string' ? ownerPubkey.toLowerCase() : ''
    if (!appId || !HEX_PUBKEY.test(owner) || !siteManifest) {
      return { retained: false, reason: 'invalid' }
    }

    const installedAppIds = new Set(this.getInstalledAppIds({ _localStorage }))
    const now = _now()
    const { recent } = this.partitionSingleNappOwners(
      siteManifest.meta?.singleNappOpenedAtByOwner,
      { now, retentionMs: singleNappRetentionMs }
    )
    const isInstalled = installedAppIds.has(appId)
    const isAlreadyRetained = Object.keys(recent).length > 0

    let admissionsState = null
    if (!isInstalled && !isAlreadyRetained) {
      admissionsState = this._embeddedRetentionAdmissions({ _localStorage, _now })
      if (admissionsState.admissions.length >= maxNewPerHour) {
        this._writeEmbeddedRetentionAdmissions(admissionsState.storage, admissionsState.admissions)
        return { retained: false, reason: 'throttled' }
      }
    }

    const singleNappOpenedAtByOwner = {
      ...normalizeSingleNappOpenedAtByOwner(siteManifest.meta?.singleNappOpenedAtByOwner),
      [owner]: now
    }
    const metadata = {
      ...(siteManifest.meta || {}),
      singleNappOpenedAtByOwner
    }
    await updateSiteManifestMetadata?.(metadata)

    if (admissionsState) {
      this._writeEmbeddedRetentionAdmissions(admissionsState.storage, [
        ...admissionsState.admissions,
        { appId, at: now }
      ])
    }

    const evicted = await this.enforceEmbeddedOnlyRetentionLimit({
      _localStorage,
      _listSiteManifestsFromDb,
      _addressObjToAppId,
      _now,
      singleNappRetentionMs,
      maxRetained,
      ...cleanupDeps
    })
    return { retained: true, evicted }
  }

  // Mobile devices are more likely on metered/cellular data, so we default to
  // 'wifi' for them. Prefer UA Client Hints (Chromium); fall back to the same
  // viewport breakpoint the UI uses for "mobile".
  static getDefaultUpdateMode ({
    _navigator = (typeof navigator !== 'undefined' ? navigator : null),
    _window = (typeof window !== 'undefined' ? window : null)
  } = {}) {
    let isMobile = false
    if (typeof _navigator?.userAgentData?.mobile === 'boolean') {
      isMobile = _navigator.userAgentData.mobile
    } else if (typeof _window?.matchMedia === 'function') {
      isMobile = _window.matchMedia(jsVars.breakpoints.mobile).matches
    }
    return isMobile ? 'wifi' : 'always'
  }

  static _singleNappOpenCounts ({ _sessionStorage } = {}) {
    const session = _sessionStorage || (typeof sessionStorage !== 'undefined' ? sessionStorage : null)
    const raw = this._readJsonStorage(session, SINGLE_NAPP_OPEN_COUNTS_KEY, {})
    const counts = {}
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return counts
    for (const [appId, count] of Object.entries(raw)) {
      const parsed = Number(count)
      if (appId && Number.isSafeInteger(parsed) && parsed > 0) counts[appId] = parsed
    }
    return counts
  }

  static markSingleNappOpen (appId, { _sessionStorage } = {}) {
    const session = _sessionStorage || (typeof sessionStorage !== 'undefined' ? sessionStorage : null)
    if (!session || !appId) return () => {}

    const counts = this._singleNappOpenCounts({ _sessionStorage: session })
    counts[appId] = (counts[appId] || 0) + 1
    this._writeJsonStorage(session, SINGLE_NAPP_OPEN_COUNTS_KEY, counts)

    let released = false
    return () => {
      if (released) return
      released = true
      const nextCounts = this._singleNappOpenCounts({ _sessionStorage: session })
      const nextCount = (nextCounts[appId] || 0) - 1
      if (nextCount > 0) nextCounts[appId] = nextCount
      else delete nextCounts[appId]
      this._writeJsonStorage(
        session,
        SINGLE_NAPP_OPEN_COUNTS_KEY,
        Object.keys(nextCounts).length ? nextCounts : undefined
      )
    }
  }

  static singleNappOpenCount ({ _sessionStorage } = {}) {
    return Object.values(this._singleNappOpenCounts({ _sessionStorage }))
      .reduce((total, count) => total + count, 0)
  }

  static tryMarkSingleNappOpen (appId, {
    _sessionStorage,
    maxActive = MAX_ACTIVE_EMBEDDED_APPS
  } = {}) {
    if (!appId) {
      return {
        accepted: false,
        reason: 'invalid',
        release: () => {}
      }
    }

    const activeCount = this.singleNappOpenCount({ _sessionStorage })
    if (Number.isFinite(maxActive) && activeCount >= maxActive) {
      return {
        accepted: false,
        reason: 'active-limit',
        activeCount,
        release: () => {}
      }
    }

    return {
      accepted: true,
      activeCount: activeCount + 1,
      release: this.markSingleNappOpen(appId, { _sessionStorage })
    }
  }

  static isSingleNappOpen (appId, { _sessionStorage } = {}) {
    return (this._singleNappOpenCounts({ _sessionStorage })[appId] || 0) > 0
  }

  static onDraftAppUpdated (listener) {
    if (typeof listener !== 'function') return () => {}
    this._draftUpdateListeners.add(listener)
    return () => this._draftUpdateListeners.delete(listener)
  }

  static _emitDraftAppUpdated (payload) {
    for (const listener of this._draftUpdateListeners) {
      try {
        listener(payload)
      } catch (err) {
        console.error('Draft app update listener failed', err)
      }
    }
  }

  static _draftUpdateMode (deps = {}) {
    return this._appUpdateMode(deps) === 'always'
      ? 'always'
      : this.getDefaultUpdateMode(deps)
  }

  static _canAutoApplyDraftUpdate ({ _navigator, ...deps } = {}) {
    const mode = this._draftUpdateMode({ _navigator, ...deps })
    return mode === 'always' || (mode === 'wifi' && !this._isMetered({ _navigator }))
  }

  static _draftWatchTargets (appIds, { _appIdToAddressObj = appIdToAddressObj } = {}) {
    const targets = new Map()
    for (const appId of appIds || []) {
      try {
        const address = _appIdToAddressObj(appId)
        if (address.kind !== DRAFT_SITE_MANIFEST_KIND) continue
        targets.set(appId, address)
      } catch (_err) {
        continue
      }
    }
    return targets
  }

  static _draftWatchKey (targets) {
    return Array.from(targets.keys()).sort().join('\n')
  }

  static async _draftWatchRelays (targets, {
    _getUserRelays = getUserRelays
  } = {}) {
    const pubkeys = Array.from(new Set(Array.from(targets.values()).map(v => v.pubkey)))
    const picked = new Set(nappRelays)
    if (pubkeys.length > 0) {
      try {
        const userRelays = await _getUserRelays(pubkeys)
        for (const pubkey of pubkeys) {
          for (const relay of userRelays?.[pubkey]?.write || []) picked.add(relay)
        }
      } catch (err) {
        console.warn('Failed to discover draft app relays; using Napp relays only', err)
      }
    }
    return Array.from(picked)
  }

  static _draftEventAppId (event, targets, {
    _addressObjToAppId = addressObjToAppId
  } = {}) {
    if (event?.kind !== DRAFT_SITE_MANIFEST_KIND || !event.pubkey) return null
    const dTag = event.tags?.find(t => t[0] === 'd')?.[1] ?? ''
    let appId
    try {
      appId = _addressObjToAppId({ kind: event.kind, pubkey: event.pubkey, dTag })
    } catch (_err) {
      return null
    }
    return targets.has(appId) ? appId : null
  }

  static _newerDraftEvent (a, b) {
    if (!a) return b || null
    if (!b) return a
    if ((b.created_at || 0) > (a.created_at || 0)) return b
    return a
  }

  static async _handleDraftUpdateEvent (event, targets, {
    _getSiteManifestFromDb = getSiteManifestFromDb,
    ...deps
  } = {}) {
    const appId = this._draftEventAppId(event, targets, deps)
    if (!appId) return { accepted: false, reason: 'not-watched' }

    const localManifest = await _getSiteManifestFromDb(appId)
    if (localManifest && (event.created_at || 0) <= (localManifest.created_at || 0)) {
      return { accepted: false, reason: 'not-newer' }
    }

    return this._queueDraftUpdateEvent(appId, event, { _getSiteManifestFromDb, ...deps })
  }

  static async _queueDraftUpdateEvent (appId, event, deps = {}) {
    const pending = this._draftPendingEvents.get(appId)
    this._draftPendingEvents.set(appId, this._newerDraftEvent(pending, event))
    if (this._draftApplyingAppIds.has(appId)) return { accepted: true, queued: true }
    return this._drainDraftUpdateQueue(appId, deps)
  }

  static async _drainDraftUpdateQueue (appId, deps = {}) {
    if (this._draftApplyingAppIds.has(appId)) return { accepted: true, queued: true }
    this._draftApplyingAppIds.add(appId)
    try {
      while (this._draftPendingEvents.has(appId)) {
        if (!this._canAutoApplyDraftUpdate(deps)) return { accepted: true, deferred: true }

        const event = this._draftPendingEvents.get(appId)
        this._draftPendingEvents.delete(appId)

        let updateError = null
        for await (const report of this.updateApp(event, {
          ...deps,
          assetBudgetMode: 'autoUpdate'
        })) {
          if (report.error) {
            updateError = report.error
            break
          }
        }

        if (updateError) {
          console.error(`Draft update of ${appId} failed`, updateError)
          return { accepted: true, error: updateError }
        }

        this._emitDraftAppUpdated({ appId, event })
      }
      return { accepted: true, applied: true }
    } finally {
      this._draftApplyingAppIds.delete(appId)
    }
  }

  static async applyPendingDraftUpdates (deps = {}) {
    if (!this._canAutoApplyDraftUpdate(deps)) return false
    const appIds = Array.from(this._draftPendingEvents.keys())
    for (const appId of appIds) {
      await this._drainDraftUpdateQueue(appId, deps)
    }
    return appIds.length > 0
  }

  static async _runDraftUpdateFeed (targets, {
    _nostrRelays = nostrRelays,
    _getSiteManifestFromDb = getSiteManifestFromDb,
    _addressObjToAppId = addressObjToAppId,
    signal,
    ...deps
  } = {}) {
    const targetValues = Array.from(targets.values())
    const localManifests = await Promise.all(
      Array.from(targets.keys()).map(appId => _getSiteManifestFromDb(appId).catch(() => null))
    )
    const localCreatedAts = localManifests
      .map(manifest => Number(manifest?.created_at))
      .filter(Number.isFinite)
    const minLocalCreatedAt = localCreatedAts.length > 0 ? Math.min(...localCreatedAts) : 0
    const filter = {
      kinds: [DRAFT_SITE_MANIFEST_KIND],
      authors: Array.from(new Set(targetValues.map(v => v.pubkey))),
      '#d': Array.from(new Set(targetValues.map(v => v.dTag))),
      since: Math.max(0, minLocalCreatedAt),
      limit: Math.max(1, targets.size * 3)
    }
    const relays = await this._draftWatchRelays(targets, deps)

    for await (const event of _nostrRelays.getEventsFeedGenerator(filter, relays, { signal })) {
      await this._handleDraftUpdateEvent(event, targets, {
        _getSiteManifestFromDb,
        _addressObjToAppId,
        signal,
        ...deps
      })
    }
  }

  static async _syncDraftUpdateWatcher (job, deps = {}) {
    if (!job || job.stopped) return
    await this.applyPendingDraftUpdates(deps)

    const targets = this._draftWatchTargets(this.getInstalledDraftAppIds(deps), deps)
    const key = this._draftWatchKey(targets)
    if (key === job.key) return

    job.abort?.abort()
    job.abort = null
    job.key = key
    if (targets.size === 0) return

    const abort = new AbortController()
    job.abort = abort
    this._runDraftUpdateFeed(targets, { ...deps, signal: abort.signal })
      .catch(err => {
        if (!abort.signal.aborted) console.error('Draft app live update feed failed', err)
      })
      .finally(() => {
        if (job.abort === abort && !abort.signal.aborted) {
          job.abort = null
          job.key = ''
        }
      })
  }

  static initDraftUpdateWatchJob ({
    _window = (typeof window !== 'undefined' ? window : null),
    _setInterval = setInterval,
    _clearInterval = clearInterval,
    ...deps
  } = {}) {
    this._draftWatchStop?.()

    const job = { stopped: false, key: '', abort: null }
    const sync = () => this._syncDraftUpdateWatcher(job, deps)
    const watchTimer = _setInterval(sync, DRAFT_UPDATE_WATCH_INTERVAL_MS)
    const pendingTimer = _setInterval(
      () => this.applyPendingDraftUpdates(deps),
      DRAFT_UPDATE_PENDING_RETRY_MS
    )
    const onStorage = () => sync()
    _window?.addEventListener?.('storage', onStorage)
    sync()

    this._draftWatchStop = () => {
      if (job.stopped) return
      job.stopped = true
      job.abort?.abort()
      _clearInterval(watchTimer)
      _clearInterval(pendingTimer)
      _window?.removeEventListener?.('storage', onStorage)
      if (this._draftWatchStop) this._draftWatchStop = null
    }
    return this._draftWatchStop
  }

  // If appIds is empty, search for all apps
  static searchForUpdates (appIds, {
    _AppFileDownloader = AppFileDownloader,
    _getSiteManifestFromDb = getSiteManifestFromDb,
    _saveSiteManifestToDb = saveSiteManifestToDb,
    _localStorage
  } = {}) {
    let ids = appIds
    if (!ids || ids.length === 0) {
      ids = this.getInstalledAppIds({ _localStorage })
    }
    ids = this.filterRegularAppIds(ids)

    const key = JSON.stringify(ids.slice().sort())

    if (this._pendingSearches.has(key)) {
      return this._pendingSearches.get(key)
    }

    const promise = (async () => {
      try {
        if (ids.length === 0) return {}

        const remoteResults = await _AppFileDownloader.getSiteManifestEvents(ids)
        const updates = {}

        for (const appId of ids) {
          const localManifest = await _getSiteManifestFromDb(appId)
          const remoteResult = remoteResults[appId]

          if (remoteResult) {
            const remoteEvent = remoteResult.event
            const hasUpdate = !localManifest || remoteEvent.created_at > localManifest.created_at

            if (hasUpdate) {
              updates[appId] = remoteResult
            }

            if (localManifest) {
              await _saveSiteManifestToDb(localManifest, {
                ...localManifest.meta,
                latestUpdateEventId: hasUpdate ? remoteEvent.id : null
              })
            }
          } else if (localManifest) {
            await _saveSiteManifestToDb(localManifest, {
              ...localManifest.meta,
              latestUpdateEventId: null
            })
          }
        }

        return updates
      } finally {
        this._pendingSearches.delete(key)
      }
    })()

    this._pendingSearches.set(key, promise)
    return promise
  }

  // Recomputes the unread badge count from manifest meta. Counts apps that
  // have an update available AND whose update event the user hasn't seen yet
  // (i.e. hasn't visited the app updates page while that update was visible).
  // While the user is on the app updates page, the count is forced to 0.
  static async refreshUnreadCount ({
    _getSiteManifestFromDb = getSiteManifestFromDb,
    _setWebStorageItem = setWebStorageItem,
    _localStorage
  } = {}) {
    const local = _localStorage || (typeof localStorage !== 'undefined' ? localStorage : null)

    if (this.isUserViewingUpdates) {
      _setWebStorageItem(local, 'session_unread_appUpdateCount', undefined)
      return
    }

    const allAppIds = this.filterRegularAppIds(this.getInstalledAppIds({ _localStorage: local }))
    let updateCount = 0
    for (const id of allAppIds) {
      const manifest = await _getSiteManifestFromDb(id)
      const latest = manifest?.meta?.latestUpdateEventId
      if (latest == null) continue
      if (latest !== manifest.meta.seenUpdateEventId) updateCount++
    }
    _setWebStorageItem(local, 'session_unread_appUpdateCount', updateCount || undefined)
  }

  // 'always' | 'wifi' | 'manual'. Defaults to 'always' (matches what
  // use-init-or-reset-screen seeds for new users).
  static _appUpdateMode ({ _localStorage } = {}) {
    const local = _localStorage || (typeof localStorage !== 'undefined' ? localStorage : null)
    if (!local) return 'always'
    const raw = local.getItem('config_appUpdateMode')
    if (raw == null) return 'always'
    try {
      const v = JSON.parse(raw)
      if (v === 'always' || v === 'wifi' || v === 'manual') return v
    } catch {}
    return 'always'
  }

  static _isMetered ({ _navigator } = {}) {
    const nav = _navigator || (typeof navigator !== 'undefined' ? navigator : null)
    const connection = nav?.connection || nav?.mozConnection || nav?.webkitConnection
    return connection?.metered === true
  }

  static async markUpdateAsSeen (appId, updateEventId, {
    _getSiteManifestFromDb = getSiteManifestFromDb,
    _saveSiteManifestToDb = saveSiteManifestToDb
  } = {}) {
    if (!updateEventId) return
    const manifest = await _getSiteManifestFromDb(appId)
    if (!manifest) return
    if (manifest.meta?.seenUpdateEventId === updateEventId) return
    await _saveSiteManifestToDb(manifest, {
      ...manifest.meta,
      seenUpdateEventId: updateEventId
    })
  }

  static isAppOpen (appId, { _sessionStorage, _localStorage } = {}) {
    const session = _sessionStorage || (typeof sessionStorage !== 'undefined' ? sessionStorage : null)
    if (this.isSingleNappOpen(appId, { _sessionStorage: session })) return true

    const local = _localStorage || (typeof localStorage !== 'undefined' ? localStorage : null)
    if (!session || !local) return false
    const workspaceKeys = JSON.parse(local.getItem('session_workspaceKeys') || '[]')
    for (const wsKey of workspaceKeys) {
      const openAppKeys = JSON.parse(session.getItem(`session_workspaceByKey_${wsKey}_openAppKeys`) || '[]')
      const appKeys = JSON.parse(local.getItem(`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys`) || '[]')
      if (appKeys.some(key => openAppKeys.includes(key))) return true
    }
    return false
  }

  static async scheduleCleanup (appIds = null, {
    _localStorage,
    _sessionStorage,
    _getSiteManifestFromDb = getSiteManifestFromDb,
    _listSiteManifestsFromDb = listSiteManifestsFromDb,
    _saveSiteManifestToDb = saveSiteManifestToDb,
    _deleteStaleFileChunksFromDb = deleteStaleFileChunksFromDb,
    _clearCachedFilesById = async appId => (await import('#services/app-file-manager/index.js')).default.clearCachedFilesById(appId),
    _getNostrDb = defaultGetNostrDb,
    _removeVaultAcceptedMessage = removeVaultAcceptedMessage,
    _setWebStorageItem = setWebStorageItem,
    _addressObjToAppId = addressObjToAppId,
    _navigator = (typeof navigator !== 'undefined' ? navigator : null),
    _setTimeout = setTimeout,
    _now = Date.now,
    singleNappRetentionMs = SINGLE_NAPP_RETENTION_MS,
    ifAvailable = false
  } = {}) {
    if (!_navigator?.locks) return

    // https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API#options
    return _navigator.locks.request('app-cleanup-job', { ifAvailable }, async (lock) => {
      if (!lock) return

      const now = _now()
      const idsToCheck = appIds || await this.getCleanupAppIds({
        _localStorage,
        _listSiteManifestsFromDb,
        _addressObjToAppId
      })
      const openApps = []

      for (const appId of idsToCheck) {
        if (this.isAppOpen(appId, { _sessionStorage, _localStorage })) {
          openApps.push(appId)
        } else {
          const manifest = await _getSiteManifestFromDb(appId)
          if (manifest) {
            const installedOwners = this.getInstalledOwnerPubkeysForApp(appId, { _localStorage })
            const { recent, stale, changed } = this.partitionSingleNappOwners(
              manifest.meta?.singleNappOpenedAtByOwner,
              { now, retentionMs: singleNappRetentionMs }
            )

            for (const ownerPubkey of stale) {
              if (installedOwners.has(ownerPubkey)) continue
              await this.cleanupOwnerAppData(ownerPubkey, appId, {
                _getNostrDb,
                _getSiteManifestFromDb,
                _saveSiteManifestToDb,
                _removeVaultAcceptedMessage,
                _updateSingleNappManifest: false
              })
            }

            const hasInstalledOwner = installedOwners.size > 0
            const hasRecentSingleNappOwner = Object.keys(recent).length > 0
            if (!hasInstalledOwner && !hasRecentSingleNappOwner) {
              await _clearCachedFilesById(appId)
              this.clearCachedAppMetadata(appId, {
                _localStorage,
                _setWebStorageItem
              })
              this.removeSubdomainMappingsForApp(appId, {
                _localStorage,
                _setWebStorageItem
              })
              continue
            }

            if (changed) {
              await _saveSiteManifestToDb(manifest, {
                ...manifest.meta,
                singleNappOpenedAtByOwner: recent
              })
            }

            const fileRootHashes = getManifestAssetDescriptors(manifest).map(asset => asset.root)
            await _deleteStaleFileChunksFromDb(appId, fileRootHashes)
          }
        }
      }

      if (openApps.length > 0) {
        _setTimeout(() => {
          this.scheduleCleanup(openApps, {
            _localStorage,
            _sessionStorage,
            _getSiteManifestFromDb,
            _listSiteManifestsFromDb,
            _saveSiteManifestToDb,
            _deleteStaleFileChunksFromDb,
            _clearCachedFilesById,
            _getNostrDb,
            _removeVaultAcceptedMessage,
            _setWebStorageItem,
            _addressObjToAppId,
            _navigator,
            _setTimeout,
            _now,
            singleNappRetentionMs
          })
        }, 5 * 60 * 1000)
      }
    })
  }

  static initCleanupJob ({ _setTimeout = setTimeout, ...deps } = {}) {
    _setTimeout(() => this.scheduleCleanup(null, { ...deps, ifAvailable: true }), 2 * 60 * 1000)
  }

  static async scheduleUpdateCheck ({
    _navigator = (typeof navigator !== 'undefined' ? navigator : null),
    _window = (typeof window !== 'undefined' ? window : null),
    _setTimeout = setTimeout,
    ifAvailable = false,
    interval = 15 * 60 * 1000,
    ...deps
  } = {}) {
    if (!_navigator?.locks) return

    return _navigator.locks.request('app-update-check-job', { ifAvailable }, async (lock) => {
      if (!lock) return

      try {
        const updates = await this.searchForUpdates(null, deps)
        const mode = this._appUpdateMode(deps)
        const shouldAutoApply = mode === 'always' ||
          (mode === 'wifi' && !this._isMetered({ _navigator }))
        if (shouldAutoApply) {
          const events = Object.values(updates).map(u => u.event)
          if (events.length > 0) {
            for await (const report of this.updateApps(events, {
              ...deps,
              assetBudgetMode: 'autoUpdate'
            })) {
              if (report.error) console.error(`Auto update of ${report.appId} failed`, report.error)
            }
          }
        }

        const embeddedMode = this.getDefaultUpdateMode({ _navigator, _window })
        const shouldAutoApplyEmbedded = embeddedMode === 'always' ||
          (embeddedMode === 'wifi' && !this._isMetered({ _navigator }))
        if (shouldAutoApplyEmbedded) {
          const embeddedAppIds = await this.getEmbeddedOnlyAppIds(deps)
          if (embeddedAppIds.length > 0) {
            const embeddedUpdates = await this.searchForUpdates(embeddedAppIds, deps)
            const embeddedEvents = Object.values(embeddedUpdates).map(u => u.event)
            if (embeddedEvents.length > 0) {
              for await (const report of this.updateApps(embeddedEvents, {
                ...deps,
                assetBudgetMode: 'autoUpdate'
              })) {
                if (report.error) console.error(`Auto update of embedded app ${report.appId} failed`, report.error)
              }
            }
          }
        }

        await this.refreshUnreadCount(deps)
      } catch (err) {
        console.error('Update check failed', err)
      }

      _setTimeout(() => {
        this.scheduleUpdateCheck({
          _navigator,
          _window,
          _setTimeout,
          interval,
          ...deps
        })
      }, interval)
    })
  }

  static initUpdateCheckJob ({ _setTimeout = setTimeout, ...deps } = {}) {
    _setTimeout(() => this.scheduleUpdateCheck({ ...deps, ifAvailable: true }), 1 * 60 * 1000)
  }

  static async * updateApp (nextSiteManifestEvent, {
    _AppFileDownloader = AppFileDownloader,
    _deleteStaleFileChunksFromDb = deleteStaleFileChunksFromDb,
    _saveSiteManifestToDb = saveSiteManifestToDb,
    _getSiteManifestFromDb = getSiteManifestFromDb,
    _addressObjToAppId = addressObjToAppId,
    _getUserRelays = getUserRelays,
    _sumFileChunkBytesFromDb = sumFileChunkBytesFromDb,
    _localStorage,
    _sessionStorage,
    writeRelays,
    assetBudgetMode = 'foreground',
    requestAssetBudgetConfirmation
  } = {}) {
    // Yield a queued report so consumers can render a pending state while we
    // wait for a free concurrency slot. Auto and manual paths funnel through
    // here, so they share the same queue (MAX_CONCURRENT_UPDATES).
    yield { appProgress: 0, fileProgress: 0, error: null, queued: true }
    await this._acquireUpdateSlot()
    try {
      const dTag = nextSiteManifestEvent.tags.find(t => t[0] === 'd')?.[1] ?? ''
      const appId = _addressObjToAppId({
        kind: nextSiteManifestEvent.kind,
        pubkey: nextSiteManifestEvent.pubkey,
        dTag
      })

      if (!writeRelays) {
        const relays = await _getUserRelays([nextSiteManifestEvent.pubkey])
        writeRelays = Array.from(relays[nextSiteManifestEvent.pubkey].write)
      }

      const filesByRoot = new Map()
      for (const asset of getManifestAssetDescriptors(nextSiteManifestEvent)) {
        if (!asset.paths.length || filesByRoot.has(asset.root)) continue
        filesByRoot.set(asset.root, {
          rootHash: asset.root,
          filename: asset.paths[0],
          service: asset.service,
          mimeType: asset.mimeType,
          size: asset.size
        })
      }
      const files = [...filesByRoot.values()]
      const fileRootHashes = files.map(f => f.rootHash)
      const localManifestBeforeUpdate = await _getSiteManifestFromDb(appId)
      const oldRootHashes = localManifestBeforeUpdate
        ? getManifestAssetDescriptors(localManifestBeforeUpdate).map(asset => asset.root)
        : []
      const replacement = {
        oldBytes: oldRootHashes.length > 0
          ? await _sumFileChunkBytesFromDb(appId, oldRootHashes)
          : 0,
        newBytes: 0
      }

      const totalFiles = files.length

      for (let i = 0; i < totalFiles; i++) {
        const file = files[i]
        const downloader = new _AppFileDownloader(appId, file.rootHash, writeRelays, {
          service: file.service,
          mimeType: file.mimeType,
          size: file.size
        })

        try {
          for await (const report of downloader.run({
            assetBudget: {
              mode: assetBudgetMode,
              filename: file.filename,
              requestConfirmation: requestAssetBudgetConfirmation,
              replacement
            }
          })) {
            if (report.error) {
              yield { appProgress: 0, fileProgress: 0, error: report.error }
              return
            }

            const appProgress = Math.floor(((i * 100) + report.progress) / totalFiles)
            yield {
              appProgress,
              fileProgress: report.progress,
              currentFile: file.filename,
              error: null
            }
          }
        } catch (err) {
          yield { appProgress: 0, fileProgress: 0, error: err }
          return
        }
      }

      if (this.isAppOpen(appId, { _sessionStorage, _localStorage })) {
        await this.scheduleCleanup([appId], {
          _localStorage,
          _sessionStorage,
          _getSiteManifestFromDb,
          _deleteStaleFileChunksFromDb
        })
      } else {
        await _deleteStaleFileChunksFromDb(appId, fileRootHashes)
      }

      const localManifest = await _getSiteManifestFromDb(appId)
      const singleNappOpenedAtByOwner = normalizeSingleNappOpenedAtByOwner(
        localManifest?.meta?.singleNappOpenedAtByOwner
      )

      await _saveSiteManifestToDb(nextSiteManifestEvent, { singleNappOpenedAtByOwner })
    } finally {
      this._releaseUpdateSlot()
    }
  }

  static async * updateApps (nextSiteManifestEvents, {
    _updateApp = this.updateApp,
    _addressObjToAppId = addressObjToAppId,
    ...deps
  } = {}) {
    const totalApps = nextSiteManifestEvents.length

    for (let i = 0; i < totalApps; i++) {
      const event = nextSiteManifestEvents[i]
      const dTag = event.tags.find(t => t[0] === 'd')?.[1] ?? ''
      const appId = _addressObjToAppId({
        kind: event.kind,
        pubkey: event.pubkey,
        dTag
      })

      const iterator = _updateApp.call(this, event, { _addressObjToAppId, ...deps })

      try {
        for await (const report of iterator) {
          const overallProgress = Math.floor(((i * 100) + report.appProgress) / totalApps)
          yield {
            appId,
            ...report,
            overallProgress
          }
        }
      } catch (err) {
        yield {
          appId,
          appProgress: 0,
          fileProgress: 0,
          error: err,
          overallProgress: Math.floor((i * 100) / totalApps)
        }
      }
    }
  }
}
