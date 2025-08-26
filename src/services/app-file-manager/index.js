import { appIdToAddressObj, findRouteFileTag } from '#helpers/app.js'
import getBundleEvent from './get-bundle-event.js'
import cacheMissingChunks from './cache-missing-chunks'
import { countFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import mime from 'mime'

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
  static async create (appId, addressObj) {
    if (this.#instancePromisesByAppId[appId]) return this.#instancePromisesByAppId[appId]
    const p = Promise.withResolvers()
    this.#instancePromisesByAppId[appId] = p.promise

    addressObj ??= appIdToAddressObj(appId)
    let bundle, attempts
    do {
      bundle = await getBundleEvent(appId, addressObj)
      if (!bundle) {
        attempts++
        console.log('Retrying bundle fetching')
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, Math.min(10, attempts)) * 1000))
      }
    } while (!bundle && attempts < 20)

    if (!bundle) {
      delete this.#instancePromisesByAppId[appId]
      p.reject(new Error(`Couldn't find bundle after ${attempts} attempts`))
    }
    const ret = new this(createToken, { appId, addressObj, bundle })
    p.resolve(ret)
    return p.promise
  }

  #faviconMetadata
  getFaviconMetadata () {
    if (this.#faviconMetadata) return this.#faviconMetadata
    let mimeType
    const tag = this.bundle.tags.find(t =>
      t[0] === 'file' &&
      /^favicon\.\w{3,}$/.test(t[2]) && (
        (!!t[3] && t[3].startsWith('image/') && (mimeType = t[3])) ||
        ((mimeType = mime.getType(t[2])) || '').startsWith('image/')
      )
    )
    if (!tag) return

    return (this.#faviconMetadata = {
      rootHash: tag[1],
      filename: tag[2],
      mimeType,
      contentType: getContentType(mimeType),
      relayHints: [tag[4]].filter(Boolean),
      tag
    })
  }

  getFileRootHash (pathname, fileTag) {
    fileTag ??= findRouteFileTag(pathname, this.bundle.tags)
    if (!fileTag) throw new Error(`No matching file tag found for path: ${pathname}`)
    return fileTag[1]
  }

  async getFileCacheStatus (pathname, fileTag, { withMeta = false } = {}) {
    fileTag ??= findRouteFileTag(pathname, this.bundle.tags)
    if (!fileTag) throw new Error(`No matching file tag found for path: ${pathname}`)
    const fileRootHash = this.getFileRootHash(null, fileTag)
    const chunkStatus = await countFileChunksFromDb(this.appId, fileRootHash)
    if (!withMeta) return { isCached: chunkStatus.count === chunkStatus.total }

    const mimeType =
      !!fileTag[3] && fileTag[3].startsWith('image/')
        ? fileTag[3]
        : mime.getType(fileTag[2])

    return {
      ...chunkStatus,
      isCached: chunkStatus.count === chunkStatus.total,
      contentType: getContentType(mimeType)
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
  async cacheFile (pathname, fileTag, progressCallback, { shouldCacheMissingFiles = !navigator.connection?.metered } = {}) {
    fileTag ??= findRouteFileTag(pathname, this.bundle.tags)
    if (!fileTag) throw new Error(`No matching file tag found for path: ${pathname}`)
    const filename = fileTag[2]
    const config = this.#getCacheFilePubSubConfig(filename)

    if (progressCallback) {
      config.subscribers.add(progressCallback)
      if (config.result !== null) progressCallback({ progress: config.result })
      if (config.error) { progressCallback({ error: config.error }); return }
    }

    const p = Promise.withResolvers()
    config.subscribers.add(({ progress, error }) => {
      if (progress >= 100) {
        p.resolve()
        if (!shouldCacheMissingFiles) return
        this.cacheMissingAppFiles(filename) // does nothing if already running
      } else if (error) p.reject()
    })
    this.#cacheFileInBackground(filename, fileTag)
    return p.promise
  }

  #isCacheMissingAppFilesRunning = false
  async cacheMissingAppFiles (lastCachedFilename) {
    if (this.#isCacheMissingAppFilesRunning) return

    this.#isCacheMissingAppFilesRunning = true
    try {
      const seenFilenames = { ...(lastCachedFilename && { [lastCachedFilename]: true }) }
      const fileTags = this.bundle.tags
        .filter(t => {
          if (t[0] !== 'file' || !t[1] || !t[2] || seenFilenames[t[2]]) return false
          return (seenFilenames[t[2]] = true)
        })

      for (const fileTag of fileTags) {
        await this.cacheFile(`/${fileTag[2]}`, fileTag, null, { shouldCacheMissingFiles: false })
      }
    } finally {
      this.#isCacheMissingAppFilesRunning = false
    }
  }

  #isCacheFileInBackgroundRunning = {} // { [filename]: true }
  async #cacheFileInBackground (filename, fileTag) {
    if (this.#isCacheFileInBackgroundRunning[filename]) return

    this.#isCacheFileInBackgroundRunning[filename] = true
    const iterator = cacheMissingChunks(this.appId, this.bundle, filename, fileTag)
    const config = this.#getCacheFilePubSubConfig(filename)

    try {
      for await (const progress of iterator) {
        config.result = progress
        for (const sub of config.subscribers) {
          try { sub({ progress }) } catch (err) { console.log(err) }
        }
      }

      if (config.result >= 100) return

      const error = new Error(`File caching incomplete, stopped at ${config.result}%`)
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
