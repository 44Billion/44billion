import AppFileDownloader from '#services/app-file-downloader/index.js'
import { getBundleFromDb, saveBundleToDb } from '#services/idb/browser/queries/bundle.js'
import { deleteStaleFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import { addressObjToAppId } from '#helpers/app.js'
import { getUserRelays } from '#helpers/nostr-queries.js'
import { setWebStorageItem } from '#helpers/web-storage.js'

export default class AppUpdater {
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
  static async searchForUpdates (appIds, {
    _AppFileDownloader = AppFileDownloader,
    _getBundleFromDb = getBundleFromDb,
    _saveBundleToDb = saveBundleToDb,
    _setWebStorageItem = setWebStorageItem,
    _localStorage
  } = {}) {
    let ids = appIds
    let allAppIds

    if (!ids || ids.length === 0) {
      allAppIds = this.getInstalledAppIds({ _localStorage })
      ids = allAppIds
    }

    if (ids.length === 0) return {}

    const remoteResults = await _AppFileDownloader.getBundleEvents(ids)
    const updates = {}

    for (const appId of ids) {
      const localBundle = await _getBundleFromDb(appId)
      const remoteResult = remoteResults[appId]

      if (remoteResult) {
        const remoteEvent = remoteResult.event
        let hasUpdate = false

        if (!localBundle) {
          // "fetched bundle event is the only one"
          hasUpdate = true
        } else if (remoteEvent.created_at > localBundle.created_at) {
          // "or more recent then the one stored on indexeddb"
          hasUpdate = true
        }

        if (hasUpdate) {
          updates[appId] = remoteResult
        }

        if (localBundle) {
          // Update the local bundle record to reflect update status
          // We preserve existing metadata but update 'hasUpdate'
          await _saveBundleToDb(localBundle, { ...localBundle.meta, hasUpdate })
        }
      } else if (localBundle) {
        // No remote bundle found, so no update
        await _saveBundleToDb(localBundle, { ...localBundle.meta, hasUpdate: false })
      }
    }

    if (!allAppIds) {
      allAppIds = this.getInstalledAppIds({ _localStorage })
    }

    let updateCount = 0
    for (const id of allAppIds) {
      const bundle = await _getBundleFromDb(id)
      if (bundle?.meta?.hasUpdate) updateCount++
    }
    _setWebStorageItem(_localStorage || (typeof localStorage !== 'undefined' ? localStorage : null), 'session_unread_appUpdateCount', updateCount)

    return updates
  }

  static isAppOpen (appId, { _localStorage } = {}) {
    const storage = _localStorage || (typeof localStorage !== 'undefined' ? localStorage : null)
    if (!storage) return false
    const workspaceKeys = JSON.parse(storage.getItem('session_workspaceKeys') || '[]')
    for (const wsKey of workspaceKeys) {
      const openAppKeys = JSON.parse(storage.getItem(`session_workspaceByKey_${wsKey}_openAppKeys`) || '[]')
      const appKeys = JSON.parse(storage.getItem(`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys`) || '[]')
      if (appKeys.some(key => openAppKeys.includes(key))) return true
    }
    return false
  }

  static async scheduleCleanup (appIds = null, {
    _localStorage,
    _getBundleFromDb = getBundleFromDb,
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
        if (this.isAppOpen(appId, { _localStorage })) {
          openApps.push(appId)
        } else {
          const bundle = await _getBundleFromDb(appId)
          if (bundle) {
            const fileRootHashes = bundle.tags
              .filter(t => t[0] === 'file')
              .map(t => t[1])
            await _deleteStaleFileChunksFromDb(appId, fileRootHashes)
          }
        }
      }

      if (openApps.length > 0) {
        _setTimeout(() => {
          this.scheduleCleanup(openApps, {
            _localStorage,
            _getBundleFromDb,
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

  static async * updateApp (nextBundleEvent, {
    _AppFileDownloader = AppFileDownloader,
    _deleteStaleFileChunksFromDb = deleteStaleFileChunksFromDb,
    _saveBundleToDb = saveBundleToDb,
    _getBundleFromDb = getBundleFromDb,
    _addressObjToAppId = addressObjToAppId,
    _getUserRelays = getUserRelays,
    _localStorage,
    writeRelays
  } = {}) {
    const dTag = nextBundleEvent.tags.find(t => t[0] === 'd')?.[1]
    const appId = _addressObjToAppId({
      kind: nextBundleEvent.kind,
      pubkey: nextBundleEvent.pubkey,
      dTag
    })

    if (!writeRelays) {
      const relays = await _getUserRelays([nextBundleEvent.pubkey])
      writeRelays = Array.from(relays[nextBundleEvent.pubkey].write)
    }

    const files = nextBundleEvent.tags
      .filter(t => t[0] === 'file')
      .map(t => ({ rootHash: t[1], filename: t[2] }))

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

    if (this.isAppOpen(appId, { _localStorage })) {
      await this.scheduleCleanup([appId], {
        _localStorage,
        _getBundleFromDb,
        _deleteStaleFileChunksFromDb
      })
    } else {
      await _deleteStaleFileChunksFromDb(appId, fileRootHashes)
    }

    const localBundle = await _getBundleFromDb(appId)
    const lastOpenedAsSingleNappAt = localBundle?.meta?.lastOpenedAsSingleNappAt || 0

    await _saveBundleToDb(nextBundleEvent, { hasUpdate: false, lastOpenedAsSingleNappAt })
  }

  static async * updateApps (nextBundleEvents, {
    _updateApp = this.updateApp,
    _addressObjToAppId = addressObjToAppId,
    ...deps
  } = {}) {
    const totalApps = nextBundleEvents.length

    for (let i = 0; i < totalApps; i++) {
      const event = nextBundleEvents[i]
      const dTag = event.tags.find(t => t[0] === 'd')?.[1]
      const appId = _addressObjToAppId({
        kind: event.kind,
        pubkey: event.pubkey,
        dTag
      })

      const iterator = _updateApp(event, { _addressObjToAppId, ...deps })

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
