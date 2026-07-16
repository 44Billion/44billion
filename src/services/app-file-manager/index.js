import { appIdToAddressObj } from '#helpers/app.js'
import { findRouteAssetDescriptor, getManifestAssetDescriptors } from '#helpers/site-manifest.js'
import getSiteManifestEvent from './get-site-manifest-event.js'
import AppFileDownloader from '#services/app-file-downloader/index.js'
import { getUserRelays } from '#helpers/nostr-queries.js'
import { nappRelays } from '#config/relays.js'
import { countFileChunksFromDb, deleteFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import { saveSiteManifestToDb, deleteSiteManifestFromDb } from '#services/idb/browser/queries/site-manifest.js'
import mime from 'mime'
import { setWebStorageItem } from '#hooks/use-web-storage.js'
import { getIcon, getName, getDescription } from './get-metadata.js'
import { ASSET_BUDGET_BACKGROUND_DENIED } from '#services/app-asset-budget/index.js'

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

function normalizeAssetArgument (asset, manifest, pathname) {
  if (!asset) return findRouteAssetDescriptor(pathname, manifest)
  if (!Array.isArray(asset)) return asset
  if (asset.descriptor) return asset.descriptor
  const filename = asset[1]?.startsWith('/') ? asset[1].slice(1) : asset[1]
  return {
    service: manifest.tags.find(tag => tag[0] === 'service')?.[1] === 'irfs' ? 'irfs' : 'blossom',
    root: asset[2],
    paths: filename ? [filename] : [],
    filename,
    mimeType: null,
    size: null,
    tag: asset
  }
}

const createToken = Symbol('createToken')

export default class AppFileManager {
  constructor (token, config) {
    if (token !== createToken) throw new Error('Use AppFileCacher.create(appAddress) to instantiate this class.')

    Object.assign(this, config)
  }

  static #instancePromisesByAppId = {}
  // Clears cached files for an app without requiring the site manifest to be fetchable.
  // If a resolved instance is already in cache (manifest was downloaded), uses it to
  // also abort any running cache operations. Otherwise falls back to direct DB deletion.
  static async clearCachedFilesById (appId) {
    const existing = this.#instancePromisesByAppId[appId]
      ? await this.#instancePromisesByAppId[appId].catch(() => null)
      : null
    if (existing) {
      await existing.clearAppFiles()
    } else {
      await deleteFileChunksFromDb(appId)
      await deleteSiteManifestFromDb(appId)
    }
  }

  static async create (appId, addressObj, { cacheMetadata = cacheAppMetadata, getCachedMetadata = getCachedAppMetadata } = {}) {
    if (this.#instancePromisesByAppId[appId]) return this.#instancePromisesByAppId[appId]
    const p = Promise.withResolvers()
    this.#instancePromisesByAppId[appId] = p.promise

    addressObj ??= appIdToAddressObj(appId)
    let siteManifest
    let attempts = 0
    do {
      siteManifest = await getSiteManifestEvent(appId, addressObj)
      if (!siteManifest) {
        attempts++
        console.log('Retrying site manifest fetching')
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, Math.min(10, attempts)) * 1000))
      }
    } while (!siteManifest && attempts < 2)

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

  get service () {
    return this.siteManifest.tags.find(t => t[0] === 'service')?.[1] || 'blossom'
  }

  #faviconMetadata
  getFaviconMetadata () {
    if (this.#faviconMetadata) return this.#faviconMetadata
    const asset = getManifestAssetDescriptors(this.siteManifest).find(descriptor =>
      descriptor.paths.some(path => /^favicon\.\w{3,}$/.test(path))
    )
    if (!asset) return
    const filename = asset.paths.find(path => /^favicon\.\w{3,}$/.test(path))
    const mimeType = asset.mimeType || mime.getType(filename)
    if (!(mimeType || '').startsWith('image/')) return

    return (this.#faviconMetadata = {
      rootHash: asset.root,
      filename,
      mimeType,
      contentType: getContentType(mimeType),
      size: asset.size,
      service: asset.service,
      tag: asset
    })
  }

  getFileRootHash (pathname, asset) {
    asset = normalizeAssetArgument(asset, this.siteManifest, pathname)
    if (!asset) throw new Error(`No matching manifest asset found for path: ${pathname}`)
    return asset.root
  }

  async getFileCacheStatus (pathname, asset, { withMeta = false } = {}) {
    asset = normalizeAssetArgument(asset, this.siteManifest, pathname)
    if (!asset) throw new Error(`No matching manifest asset found for path: ${pathname}`)
    const fileRootHash = asset.root
    const chunkStatus = await countFileChunksFromDb(this.appId, fileRootHash)
    if (!withMeta) return { isCached: chunkStatus.count === chunkStatus.total }

    const filename = asset.filename || asset.paths[0]
    const mimeType = asset.mimeType || mime.getType(filename)

    return {
      ...chunkStatus,
      isCached: chunkStatus.count === chunkStatus.total,
      mimeType,
      contentType: getContentType(mimeType),
      isHtml: /^text\/html\b/.test(mimeType),
      fileRootHash,
      size: asset.size,
      service: asset.service,
      pathTag: asset
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
  async cacheFile (pathname, asset, progressCallback, {
    shouldCacheMissingFiles = !navigator.connection?.metered,
    assetBudget = {}
  } = {}) {
    asset = normalizeAssetArgument(asset, this.siteManifest, pathname)
    if (!asset) throw new Error(`No matching manifest asset found for path: ${pathname}`)
    const filename = asset.filename || asset.paths[0]
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
    this.#cacheFileInBackground(filename, asset, assetBudget)
    return p.promise
  }

  #isCacheMissingAppFilesRunning = false
  async cacheMissingAppFiles (lastCachedFilename) {
    if (this.#isCacheMissingAppFilesRunning) return

    this.#isCacheMissingAppFilesRunning = true
    try {
      const seenFilenames = new Set(lastCachedFilename ? [lastCachedFilename] : [])
      const assets = []
      for (const descriptor of getManifestAssetDescriptors(this.siteManifest)) {
        for (const filename of descriptor.paths) {
          if (seenFilenames.has(filename)) continue
          seenFilenames.add(filename)
          assets.push({ ...descriptor, filename })
        }
      }

      for (const asset of assets) {
        if (!this.#isCacheMissingAppFilesRunning) break // poor man's abort controller
        try {
          await this.cacheFile(asset.filename, asset, null, {
            shouldCacheMissingFiles: false,
            assetBudget: { mode: 'background' }
          })
        } catch (err) {
          if (err.code !== ASSET_BUDGET_BACKGROUND_DENIED) console.log('Background app asset caching stopped:', err)
          break
        }
      }
    } finally {
      this.#isCacheMissingAppFilesRunning = false
    }
  }

  #isCacheFileInBackgroundRunning = {} // { [filename]: true }
  async #cacheFileInBackground (filename, asset, assetBudget = {}) {
    if (this.#isCacheFileInBackgroundRunning[filename]) return

    this.#isCacheFileInBackgroundRunning[filename] = true
    const config = this.#getCacheFilePubSubConfig(filename)

    try {
      const relays = await getUserRelays([this.siteManifest.pubkey])
      const writeRelays = Array.from(relays[this.siteManifest.pubkey]?.write || [])
      if (writeRelays.length === 0) writeRelays.push(...nappRelays)

      const mimeType = asset.mimeType || mime.getType(filename)
      const downloader = new AppFileDownloader(this.appId, asset.root, writeRelays, {
        service: asset.service,
        mimeType,
        size: asset.size
      })

      for await (const report of downloader.run({ assetBudget: { ...assetBudget, filename } })) {
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
