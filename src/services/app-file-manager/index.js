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

  #cacheFileMemo = {} // { filename: { subscribers: Set(), progress: null } }

  // runs caching process and calls progressCallback with { progress: 0-100 } or { error }
  async cacheFile (pathname, fileTag, progressCallback) {
    fileTag ??= findRouteFileTag(pathname, this.bundle.tags)
    if (!fileTag) throw new Error(`No matching file tag found for path: ${pathname}`)
    const filename = fileTag[2]

    let memo = this.#cacheFileMemo[filename]
    if (memo) {
      memo.subscribers.add(progressCallback)
      if (memo.progress !== null) { progressCallback({ progress: memo.progress }) }
      return
    }

    memo = {
      subscribers: new Set([progressCallback]),
      progress: null
    }
    this.#cacheFileMemo[filename] = memo

    try {
      const { appId, bundle } = this
      const iterator = cacheMissingChunks(appId, bundle, filename, fileTag)

      for await (const progress of iterator) {
        memo.progress = progress
        for (const sub of memo.subscribers) { sub({ progress }) }
      }

      if (memo.progress < 100) {
        const error = new Error(`File caching incomplete, stopped at ${memo.progress}%`)
        for (const sub of memo.subscribers) { sub({ error }) }
      } else {
        const isOnCheapInternet = !navigator.connection?.metered
        if (isOnCheapInternet) this.cacheMissingAppFiles(filename) // does nothing if already running
      }
    } catch (error) {
      console.error(`Failed to cache ${filename}`, error)
      for (const sub of memo.subscribers) { sub({ error }) }
    } finally {
      delete this.#cacheFileMemo[filename]
    }
  }

  #isCacheMissingAppFilesRunning = false
  async cacheMissingAppFiles (lastCachedFilename) {
    if (this.#isCacheMissingAppFilesRunning) return

    this.#isCacheMissingAppFilesRunning = true
    try {
      const { appId, bundle } = this
      const fileTags = [...new Set(bundle.tags
        .filter(t => t[0] === 'file' && !!t[1] && t[2] !== lastCachedFilename)
      )]

      for (const fileTag of fileTags) {
        // eslint-disable-next-line no-empty
        for await (const _ of cacheMissingChunks(appId, bundle, null, fileTag)) {}
      }
    } finally {
      this.#isCacheMissingAppFilesRunning = false
    }
  }
}
