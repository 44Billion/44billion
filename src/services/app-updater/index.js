import AppFileDownloader from '#services/app-file-downloader/index.js'
import { getSiteManifestFromDb, saveSiteManifestToDb } from '#services/idb/browser/queries/site-manifest.js'
import { deleteStaleFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import { addressObjToAppId } from '#helpers/app.js'
import { getUserRelays } from '#helpers/nostr-queries.js'
import { setWebStorageItem } from '#helpers/web-storage.js'

export default class AppUpdater {
  static _pendingSearches = new Map()
  // Set to true while the user is on the app updates page so the unread
  // indicator stays hidden even if a background check finds new updates.
  static isUserViewingUpdates = false

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

    const allAppIds = this.getInstalledAppIds({ _localStorage: local })
    let updateCount = 0
    for (const id of allAppIds) {
      const manifest = await _getSiteManifestFromDb(id)
      const latest = manifest?.meta?.latestUpdateEventId
      if (latest == null) continue
      if (latest !== manifest.meta.seenUpdateEventId) updateCount++
    }
    _setWebStorageItem(local, 'session_unread_appUpdateCount', updateCount || undefined)
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
    _deleteStaleFileChunksFromDb = deleteStaleFileChunksFromDb,
    _navigator = (typeof navigator !== 'undefined' ? navigator : null),
    _setTimeout = setTimeout,
    ifAvailable = false
  } = {}) {
    if (!_navigator?.locks) return

    // https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API#options
    return _navigator.locks.request('app-cleanup-job', { ifAvailable }, async (lock) => {
      if (!lock) return

      const idsToCheck = appIds || this.getInstalledAppIds({ _localStorage })
      const openApps = []

      for (const appId of idsToCheck) {
        if (this.isAppOpen(appId, { _sessionStorage, _localStorage })) {
          openApps.push(appId)
        } else {
          const manifest = await _getSiteManifestFromDb(appId)
          if (manifest) {
            const fileRootHashes = manifest.tags
              .filter(t => t[0] === 'path')
              .map(t => t[2])
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
            _deleteStaleFileChunksFromDb,
            _navigator,
            _setTimeout
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
    _setTimeout = setTimeout,
    ifAvailable = false,
    interval = 15 * 60 * 1000,
    ...deps
  } = {}) {
    if (!_navigator?.locks) return

    const connection = _navigator.connection || _navigator.mozConnection || _navigator.webkitConnection
    if (connection?.metered) {
      _setTimeout(() => this.scheduleUpdateCheck({ _navigator, _setTimeout, interval, ...deps }), interval)
      return
    }

    return _navigator.locks.request('app-update-check-job', { ifAvailable }, async (lock) => {
      if (!lock) return

      try {
        await this.searchForUpdates(null, deps)
        await this.refreshUnreadCount(deps)
      } catch (err) {
        console.error('Update check failed', err)
      }

      _setTimeout(() => {
        this.scheduleUpdateCheck({
          _navigator,
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
    _localStorage,
    _sessionStorage,
    writeRelays
  } = {}) {
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

    const files = nextSiteManifestEvent.tags
      .filter(t => t[0] === 'path')
      .map(t => ({ rootHash: t[2], filename: t[1] }))

    const totalFiles = files.length

    for (let i = 0; i < totalFiles; i++) {
      const file = files[i]
      const downloader = new _AppFileDownloader(appId, file.rootHash, writeRelays)

      try {
        for await (const report of downloader.run()) {
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

    const fileRootHashes = files.map(f => f.rootHash)

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
    const lastOpenedAsSingleNappAt = localManifest?.meta?.lastOpenedAsSingleNappAt || 0

    await _saveSiteManifestToDb(nextSiteManifestEvent, { lastOpenedAsSingleNappAt })
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
