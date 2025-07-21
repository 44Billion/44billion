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
    const ret = new this(createToken, { id: appId, addressObj, bundle })
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
    const chunkStatus = await countFileChunksFromDb(fileRootHash)
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

  #cacheFileMemo = {} // { [filename]: current iterator }
  // yield 0-100 progress
  cacheFile (pathname, fileTag) {
    fileTag ??= findRouteFileTag(pathname, this.bundle.tags)
    if (!fileTag) throw new Error(`No matching file tag found for path: ${pathname}`)
    const filename = fileTag[2]
    if (this.#cacheFileMemo[filename]) {
      return this.#cacheFileMemo[filename]
    }

    const iterator = async function * () {
      try {
        const { appId, bundle } = this
        for await (const progress of cacheMissingChunks(appId, bundle, filename, fileTag)) {
          // a new consumer may find useful to know
          // current progress of ongoing iterator
          iterator.progress = progress
          yield progress
        }

        const isOnCheapInternet = !navigator.connection?.metered
        if (isOnCheapInternet) this.cacheMissingAppFiles(filename) // does nothing if already running
      } finally {
        delete this.#cacheFileMemo[filename]
      }
    }.bind(this)()

    this.#cacheFileMemo[filename] = iterator
    return iterator
  }

  #isCacheMissingAppFilesRunning = false
  async cacheMissingAppFiles (lastCachedFilename) {
    if (this.#isCacheMissingAppFilesRunning) return

    this.#isCacheMissingAppFilesRunning = true
    try {
      const { appId, bundle } = this
      const fileTags = bundle.tags
        .filter(t => t[0] === 'file' && !!t[1] && t[2] !== lastCachedFilename)
        .map(t => t[1])
        .reduce((r, v) => ({ ...r, [v]: true }), {})

      for (const fileTag of fileTags) {
        // eslint-disable-next-line no-empty
        for await (const _ of cacheMissingChunks(appId, bundle, null, fileTag)) {}
      }
    } finally {
      this.#isCacheMissingAppFilesRunning = false
    }
  }
}
