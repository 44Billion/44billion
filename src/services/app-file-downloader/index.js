import { appIdToAddressObj } from '#helpers/app.js'
import { getUserRelays, getEventsByStrategy } from '#helpers/nostr-queries.js'
import { nappRelays } from '#services/nostr-relays.js'
import {
  saveFileChunksToDB,
  countFileChunksFromDb,
  getFileChunksFromDb
} from '#services/idb/browser/queries/file-chunk.js'
import FileDownloader from '#services/file-downloader/index.js'
import BlossomFileDownloader from '#services/blossom-file-downloader/index.js'

export default class AppFileDownloader {
  /**
   * @param {string} appId
   * @param {string} fileHash - Merkle root hash (IRFS) or sha256 hex hash (Blossom)
   * @param {string[]} writeRelays
   * @param {object} [options]
   * @param {string} [options.service='blossom'] - 'blossom' or 'irfs'
   * @param {string|null} [options.mimeType=null] - expected MIME type of the file
   */
  constructor (appId, fileHash, writeRelays, { service = 'blossom', mimeType = null } = {}) {
    if (!writeRelays || writeRelays.length === 0) throw new Error('Write relays cannot be empty')
    this.appId = appId
    this.fileRootHash = fileHash
    this.writeRelays = [...new Set([...writeRelays, ...nappRelays])]
    this.service = service
    this.mimeType = mimeType
  }

  static async getSiteManifestEvents (appIds, {
    _getUserRelays = getUserRelays,
    _getEventsByStrategy = getEventsByStrategy
  } = {}) {
    if (!appIds || appIds.length === 0) return {}

    const appsByPubkey = {}
    const addressByAppId = {}

    for (const appId of appIds) {
      const address = appIdToAddressObj(appId)
      addressByAppId[appId] = address
      if (!appsByPubkey[address.pubkey]) {
        appsByPubkey[address.pubkey] = []
      }
      appsByPubkey[address.pubkey].push(address)
    }

    const pubkeys = Object.keys(appsByPubkey)
    const relays = await _getUserRelays(pubkeys)

    const filter = {
      kinds: [],
      authors: pubkeys,
      '#d': [],
      until: Math.floor(Date.now() / 1000)
    }

    for (const appId of appIds) {
      const addr = addressByAppId[appId]
      if (!filter.kinds.includes(addr.kind)) filter.kinds.push(addr.kind)
      if (!filter['#d'].includes(addr.dTag)) filter['#d'].push(addr.dTag)
    }

    // The default getEventsByStrategy already includes napp relays
    // besides the user's write relays
    const events = await _getEventsByStrategy(filter, {
      code: 'WRITE_RELAYS',
      maxRelaysPerUser: 7,
      userRelays: relays
    })

    const result = {}
    for (const appId of appIds) {
      const addr = addressByAppId[appId]
      const event = events.find(e =>
        e.kind === addr.kind &&
        e.pubkey === addr.pubkey &&
        (e.tags.find(t => t[0] === 'd')?.[1] ?? '') === addr.dTag
      )

      if (event) {
        result[appId] = {
          event,
          writeRelays: Array.from(relays[addr.pubkey]?.write || [])
        }
      }
    }

    return result
  }

  async * run ({
    _FileDownloader = FileDownloader,
    _BlossomFileDownloader = BlossomFileDownloader,
    _countFileChunksFromDb = countFileChunksFromDb,
    _getFileChunksFromDb = getFileChunksFromDb,
    _saveFileChunksToDB = saveFileChunksToDB
  } = {}) {
    if (this.service === 'blossom') {
      yield * this.#runBlossom({ _BlossomFileDownloader, _countFileChunksFromDb, _saveFileChunksToDB })
    } else {
      yield * this.#runIrfs({ _FileDownloader, _countFileChunksFromDb, _getFileChunksFromDb, _saveFileChunksToDB })
    }
  }

  async * #runBlossom ({
    _BlossomFileDownloader,
    _countFileChunksFromDb,
    _saveFileChunksToDB
  }) {
    // Check if already fully cached (chunks are stored under the sha256 hash)
    const dbInfo = await _countFileChunksFromDb(this.appId, this.fileRootHash)
    if (dbInfo.total && dbInfo.count >= dbInfo.total) {
      yield { type: 'progress', progress: 100, count: dbInfo.total, total: dbInfo.total }
      return
    }

    const { pubkey } = appIdToAddressObj(this.appId)

    const queue = []
    let p = Promise.withResolvers()
    let isDone = false

    const push = (item) => {
      queue.push(item)
      p.resolve()
      p = Promise.withResolvers()
    }

    const pendingOperations = new Set()
    const trackOperation = (operation) => {
      pendingOperations.add(operation)
      operation.finally(() => pendingOperations.delete(operation))
    }

    const downloader = new _BlossomFileDownloader(
      this.fileRootHash,
      pubkey,
      this.writeRelays,
      async data => {
        const op = (async () => {
          const { event, ...rest } = data

          if (event) {
            const fakeManifest = { tags: [['path', '', this.fileRootHash]] }
            await _saveFileChunksToDB(fakeManifest, [event], this.appId)
          }
          push(rest)
        })()
        trackOperation(op)
        await op
      },
      { mimeType: this.mimeType }
    )

    downloader.run().finally(async () => {
      await Promise.all(pendingOperations)
      isDone = true
      p.resolve()
    })

    try {
      // eslint-disable-next-line no-unmodified-loop-condition
      while (!isDone || queue.length > 0) {
        if (queue.length > 0) {
          const item = queue.shift()
          yield item
          if (item.error) return
        } else {
          await p.promise
        }
      }
    } finally {
      // nothing to clean for blossom downloader
    }
  }

  async * #runIrfs ({
    _FileDownloader,
    _countFileChunksFromDb,
    _getFileChunksFromDb,
    _saveFileChunksToDB
  }) {
    const dbInfo = await _countFileChunksFromDb(this.appId, this.fileRootHash)
    const keys = await _getFileChunksFromDb(this.appId, this.fileRootHash, { justKeys: true })
    const downloadedChunkIndexes = new Set(keys.map(k => k[2])) // k is [appId, rootHash, pos]

    const { pubkey } = appIdToAddressObj(this.appId)
    const pubkeysByRelay = {}
    for (const url of this.writeRelays) {
      pubkeysByRelay[url] = [pubkey]
    }

    const queue = []
    let p = Promise.withResolvers()
    let isDone = false

    const push = (item) => {
      queue.push(item)
      p.resolve()
      p = Promise.withResolvers()
    }

    const pendingOperations = new Set()
    const trackOperation = (operation) => {
      pendingOperations.add(operation)
      operation.finally(() => pendingOperations.delete(operation))
    }

    const downloader = new _FileDownloader(
      this.fileRootHash,
      pubkeysByRelay,
      async data => {
        const op = (async () => {
          // Remove event to save memory
          const { event, ...rest } = data
          if (event) {
            const fakeManifest = { tags: [['path', '', this.fileRootHash]] }
            await _saveFileChunksToDB(fakeManifest, [event], this.appId)
          }
          push(rest)
        })()
        trackOperation(op)
        await op
      },
      {
        totalChunks: dbInfo.total,
        downloadedChunkIndexes,
        abortOnFailure: true
      }
    )

    downloader.run().finally(async () => {
      // Without this, the `downloader` finishes and sets `isDone=true`
      // before some of our `_saveFileChunksToDB` calls are done
      // which prevents some yields
      await Promise.all(pendingOperations)
      isDone = true
      p.resolve()
    })

    try {
      // eslint-disable-next-line no-unmodified-loop-condition
      while (!isDone || queue.length > 0) {
        if (queue.length > 0) {
          const item = queue.shift()
          yield item
          if (item.error) return
        } else {
          await p.promise
        }
      }
    } finally {
      if (downloader.abortController && !downloader._isComplete?.()) {
        downloader.abortController.abort()
      }
    }
  }
}
