import { appIdToAddressObj, findRouteFileTag } from '#helpers/app.js'
import getSiteManifestEvent from './get-site-manifest-event.js'
import AppFileDownloader from '#services/app-file-downloader/index.js'
import { getUserRelays } from '#helpers/nostr-queries.js'
import { nappRelays } from '#services/nostr-relays.js'
import { countFileChunksFromDb, deleteFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import { saveSiteManifestToDb, deleteSiteManifestFromDb } from '#services/idb/browser/queries/site-manifest.js'
import mime from 'mime'
import { setWebStorageItem } from '#hooks/use-web-storage.js'
import { getIcon, getName, getDescription } from './get-metadata.js'

export function cacheAppMetadata (appId, metadata) {
  if (!appId || !metadata) { throw new Error('Missing args') }

  ['name', 'description', 'icon'].forEach(key => {
    let value = metadata[key]
    switch (key) {
      case 'icon': value = value?.fx && value?.url && { fx: value.fx, url: value.url }; break
      case 'description': value = (value?.length ?? 0) > 255 ? `${value.slice(0, 252)}...` : value; break
      case 'name': value = (value?.length ?? 0) > 100 ? `${value.slice(0, 97)}...` : value; break
    }
    if (!value) return

    // Update storage using setWebStorageItem to trigger cross-component updates
    setWebStorageItem(localStorage, `session_appById_${appId}_${key}`, value)
  })
}

export function getCachedAppMetadata (appId, metadataKeys = ['name', 'description', 'icon']) {
  if (!appId) return
  const metadata = {}
  metadataKeys.forEach(key => {
    let value = localStorage.getItem(`session_appById_${appId}_${key}`)
    if (value) {
      try { value = JSON.parse(value) } catch (_err) { console.log(`Error parsing "${key}" metadata from app "${appId}"`); return }
      metadata[key] = value
    }
  })
  return metadata
}

function getContentType (mimeType) {
  if (!mimeType) return 'application/octet-stream'
  return /^(?:text\/|application\/json)[^;]*$/.test(mimeType)
    ? `${mimeType}; charset=utf-8`
    : mimeType
}

const createToken = Symbol('createToken')

export default class AppFileManager {
  constructor (token, config) {
    if (token !== createToken) throw new Error('Use AppFileCacher.create(appAddress) to instantiate this class.')

    Object.assign(this, config)
  }

  static #instancePromisesByAppId = {}
  static async create (appId, addressObj, { cacheMetadata = cacheAppMetadata, getCachedMetadata = getCachedAppMetadata } = {}) {
    if (this.#instancePromisesByAppId[appId]) return this.#instancePromisesByAppId[appId]
    const p = Promise.withResolvers()
    this.#instancePromisesByAppId[appId] = p.promise

    addressObj ??= appIdToAddressObj(appId)
    let siteManifest, attempts
    do {
      siteManifest = await getSiteManifestEvent(appId, addressObj)
      if (!siteManifest) {
        attempts++
        console.log('Retrying site manifest fetching')
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, Math.min(10, attempts)) * 1000))
      }
    } while (!siteManifest && attempts < 20)

    if (!siteManifest) {
      delete this.#instancePromisesByAppId[appId]
      p.reject(new Error(`Couldn't find site manifest after ${attempts} attempts`))
    }
    const ret = new this(createToken, { appId, addressObj, siteManifest, cacheMetadata, getCachedMetadata })
    p.resolve(ret)
    return p.promise
  }

  async getIcon (staleWhileRevalidate = false) {
    return getIcon(this, staleWhileRevalidate)
  }

  async getName (staleWhileRevalidate = false) {
    return getName(this, staleWhileRevalidate)
  }

  async getDescription (staleWhileRevalidate = false) {
    return getDescription(this, staleWhileRevalidate)
  }

  async clearAppFiles () {
    await this.#abortCaching()
    await deleteFileChunksFromDb(this.appId)
    await deleteSiteManifestFromDb(this.appId)
  }

  async #abortCaching () {
    // Stop any running cacheMissingAppFiles operation
    this.#isCacheMissingAppFilesRunning = false

    // Abort all running cacheFile operations
    for (const filename in this.#cacheFilePubSubConfig) {
      const config = this.#cacheFilePubSubConfig[filename]
      const abortError = new Error('Cache operation aborted')
      config.error = abortError
      for (const sub of config.subscribers) {
        try {
          sub({ error: abortError })
        } catch (err) {
          console.log(err)
        }
      }
      this.#deleteCacheFilePubSubConfig(filename)
    }

    // Reset all background caching flags
    this.#isCacheFileInBackgroundRunning = {}
  }

  updateSiteManifestMetadata (metadata) {
    if (!metadata) throw new Error('Missing metadata arg')

    return saveSiteManifestToDb(this.siteManifest, { ...this.siteManifest.meta, ...metadata })
  }

  #faviconMetadata
  getFaviconMetadata () {
    if (this.#faviconMetadata) return this.#faviconMetadata
    let mimeType
    const tag = this.siteManifest.tags.find(t =>
      t[0] === 'path' &&
      /^favicon\.\w{3,}$/.test(t[1]) &&
      ((mimeType = mime.getType(t[1])) || '').startsWith('image/')
    )
    if (!tag) return

    return (this.#faviconMetadata = {
      rootHash: tag[2],
      filename: tag[1],
      mimeType,
      contentType: getContentType(mimeType),
      tag
    })
  }

  getFileRootHash (pathname, pathTag) {
    pathTag ??= findRouteFileTag(pathname, this.siteManifest.tags)
    if (!pathTag) throw new Error(`No matching path tag found for path: ${pathname}`)
    return pathTag[2]
  }

  async getFileCacheStatus (pathname, pathTag, { withMeta = false } = {}) {
    pathTag ??= findRouteFileTag(pathname, this.siteManifest.tags)
    if (!pathTag) throw new Error(`No matching path tag found for path: ${pathname}`)
    const fileRootHash = this.getFileRootHash(null, pathTag)
    const chunkStatus = await countFileChunksFromDb(this.appId, fileRootHash)
    if (!withMeta) return { isCached: chunkStatus.count === chunkStatus.total }

    const mimeType = mime.getType(pathTag[1])

    return {
      ...chunkStatus,
      isCached: chunkStatus.count === chunkStatus.total,
      mimeType,
      contentType: getContentType(mimeType),
      isHtml: /^text\/html\b/.test(mimeType),
      fileRootHash,
      pathTag
    }
  }

  #cacheFilePubSubConfig = {} // { [filename]: { subscribers: Set(), result: null, error: null } }
  #getCacheFilePubSubConfig (filename) {
    if (!filename) throw new Error('No filename')
    return (this.#cacheFilePubSubConfig[filename] ??=
      { subscribers: new Set(), result: null, error: null })
  }
  #deleteCacheFilePubSubConfig (filename) {
    delete this.#cacheFilePubSubConfig[filename]
  }
  // runs caching process and calls progressCallback with { progress: 0-100 } or { error }
  // !navigator.connection?.metered is true if user is on cheap internet
  async cacheFile (pathname, pathTag, progressCallback, { shouldCacheMissingFiles = !navigator.connection?.metered } = {}) {
    pathTag ??= findRouteFileTag(pathname, this.siteManifest.tags)
    if (!pathTag) throw new Error(`No matching path tag found for path: ${pathname}`)
    const filename = pathTag[1]
    const config = this.#getCacheFilePubSubConfig(filename)

    if (progressCallback) {
      config.subscribers.add(progressCallback)
      if (config.result !== null) progressCallback(config.result)
      if (config.error) { progressCallback({ error: config.error }); return }
    }

    const p = Promise.withResolvers()
    config.subscribers.add(({ progress, error, newlyCachedChunkIndex: _newlyCachedChunkIndex }) => {
      if (progress >= 100) {
        p.resolve()
        if (!shouldCacheMissingFiles) return
        this.cacheMissingAppFiles(filename) // does nothing if already running
      } else if (error) p.reject(error)
    })
    this.#cacheFileInBackground(filename, pathTag)
    return p.promise
  }

  #isCacheMissingAppFilesRunning = false
  async cacheMissingAppFiles (lastCachedFilename) {
    if (this.#isCacheMissingAppFilesRunning) return

    this.#isCacheMissingAppFilesRunning = true
    try {
      const seenFilenames = { ...(lastCachedFilename && { [lastCachedFilename]: true }) }
      const pathTags = this.siteManifest.tags
        .filter(t => {
          if (t[0] !== 'path' || !t[1] || !t[2] || seenFilenames[t[1]]) return false
          return (seenFilenames[t[1]] = true)
        })

      for (const pathTag of pathTags) {
        if (!this.#isCacheMissingAppFilesRunning) break // poor man's abort controller
        await this.cacheFile(pathTag[1], pathTag, null, { shouldCacheMissingFiles: false })
      }
    } finally {
      this.#isCacheMissingAppFilesRunning = false
    }
  }

  #isCacheFileInBackgroundRunning = {} // { [filename]: true }
  async #cacheFileInBackground (filename, pathTag) {
    if (this.#isCacheFileInBackgroundRunning[filename]) return

    this.#isCacheFileInBackgroundRunning[filename] = true
    const config = this.#getCacheFilePubSubConfig(filename)

    try {
      const relays = await getUserRelays([this.siteManifest.pubkey])
      const writeRelays = Array.from(relays[this.siteManifest.pubkey]?.write || [])
      if (writeRelays.length === 0) writeRelays.push(...nappRelays)

      const serviceTag = this.siteManifest.tags.find(t => t[0] === 'service')
      const service = serviceTag?.[1] || 'blossom'
      const downloader = new AppFileDownloader(this.appId, pathTag[2], writeRelays, { service })

      for await (const report of downloader.run()) {
        if (!this.#isCacheFileInBackgroundRunning[filename]) break // poor man's abort controller

        if (report.error) throw report.error

        config.result = report

        for (const sub of config.subscribers) {
          try {
            sub(report)
          } catch (err) {
            console.log(err)
          }
        }
      }

      // if we aborted early, don't continue
      if (!this.#isCacheFileInBackgroundRunning[filename]) return

      if (config.result?.progress >= 100) return

      const error = new Error(`File caching incomplete, stopped at ${config.result?.progress ?? 0}%`)
      config.error = error
      for (const sub of config.subscribers) {
        try { sub({ error }) } catch (err) { console.log(err) }
      }
    } catch (error) {
      config.error = error
      for (const sub of config.subscribers) {
        try { sub({ error }) } catch (err) { console.log(err) }
      }
    } finally {
      this.#deleteCacheFilePubSubConfig(filename)
      delete this.#isCacheFileInBackgroundRunning[filename]
    }
  }
}
