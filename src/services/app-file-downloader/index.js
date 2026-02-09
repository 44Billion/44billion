import { appIdToAddressObj } from '#helpers/app.js'
import { getUserRelays, getEventsByStrategy } from '#helpers/nostr-queries.js'
import nostrRelays, { nappRelays } from '#services/nostr-relays.js'
import {
  saveFileChunksToDB,
  countFileChunksFromDb,
  getFileChunksFromDb
} from '#services/idb/browser/queries/file-chunk.js'

const activeDownloads = new Map()

export default class AppFileDownloader {
  constructor (appId, fileRootHash, writeRelays) {
    if (!writeRelays || writeRelays.length === 0) throw new Error('Write relays cannot be empty')
    this.appId = appId
    this.fileRootHash = fileRootHash
    this.writeRelays = [...new Set([...writeRelays, ...nappRelays])]
    this.sharedKey = `${appId}:${fileRootHash}`
  }

  static async getBundleEvents (appIds, {
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
        e.tags.find(t => t[0] === 'd')?.[1] === addr.dTag
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
    _nostrRelays = nostrRelays,
    _countFileChunksFromDb = countFileChunksFromDb,
    _getFileChunksFromDb = getFileChunksFromDb,
    _saveFileChunksToDB = saveFileChunksToDB
  } = {}) {
    const deps = { _nostrRelays, _countFileChunksFromDb, _getFileChunksFromDb, _saveFileChunksToDB }
    let state = activeDownloads.get(this.sharedKey)
    if (!state) {
      state = {
        total: null,
        downloaded: new Set(),
        fetching: new Map(), // index -> Set(relayUrl)
        missingByRelay: new Map(), // relay -> Set(indexes)
        error: null,
        instances: 0,
        initPromise: null,
        queue: [],
        relayBackoffs: new Map(), // relayUrl -> currentDelay
        resolvers: new Set(),
        workersStarted: false,
        version: 0,
        stopped: false
      }
      state.initPromise = this._initState(state, deps).then(() => {
        notify()
      })
      activeDownloads.set(this.sharedKey, state)
    }
    state.instances++
    notify()

    function notify () {
      state.version++
      const resolvers = Array.from(state.resolvers)
      state.resolvers.clear()
      resolvers.forEach(resolve => resolve())
    }

    function wait (knownVersion) {
      if (state.version !== knownVersion) return Promise.resolve()
      const { promise, resolve } = Promise.withResolvers()
      state.resolvers.add(resolve)
      return promise
    }

    try {
      await state.initPromise

      const reportProgress = () => {
        const progress = state.total ? Math.floor((state.downloaded.size / state.total) * 100) : 0
        return { progress, error: state.error }
      }

      if (!state.workersStarted) {
        state.workersStarted = true
        const batchSize = 20

        const populateQueue = () => {
          if (state.total === null) {
            if (!state.downloaded.has(0) && !state.fetching.has(0) && !state.queue.includes(0)) {
              state.queue.push(0)
            }
          } else {
            for (let i = 0; i < state.total; i++) {
              if (!state.downloaded.has(i) && !state.fetching.has(i) && !state.queue.includes(i)) {
                state.queue.push(i)
              }
            }
            state.queue.sort((a, b) => a - b)
          }
        }

        this.writeRelays.forEach(relayUrl => {
          (async () => {
            try {
              while (true) {
                const lastVersion = state.version
                if (state.error || state.stopped || (state.total !== null && state.downloaded.size >= state.total)) break

                populateQueue()
                const batch = []

                // 1. Primary work from queue
                for (let i = 0; i < state.queue.length && batch.length < batchSize; i++) {
                  const idx = state.queue[i]
                  if (state.missingByRelay.get(relayUrl)?.has(idx)) continue

                  batch.push(idx)
                  state.queue.splice(i, 1)
                  i--
                  if (!state.fetching.has(idx)) state.fetching.set(idx, new Set())
                  state.fetching.get(idx).add(relayUrl)
                }

                // 2. Redundancy / Stealing
                if (batch.length < batchSize && state.total !== null) {
                  // Try stealing chunks that are being fetched by others but not by this relay
                  for (let idx = 0; idx < state.total && batch.length < batchSize; idx++) {
                    if (state.downloaded.has(idx) || batch.includes(idx)) continue
                    if (state.missingByRelay.get(relayUrl)?.has(idx)) continue
                    // Steal even if in state.fetching (by others)
                    batch.push(idx)
                    if (!state.fetching.has(idx)) state.fetching.set(idx, new Set())
                    state.fetching.get(idx).add(relayUrl)
                  }
                }

                if (batch.length === 0) {
                  if (state.total !== null && state.downloaded.size >= state.total) break
                  if (state.stopped) break
                  await wait(lastVersion)
                  continue
                }

                try {
                  const foundIndexes = await this._fetchFromRelay(relayUrl, batch, state, deps)
                  // Success: reset backoff
                  state.relayBackoffs.set(relayUrl, 1000)

                  // Re-queue chunks that were not found in this relay if no one else is downloading them
                  for (const idx of batch) {
                    if (!foundIndexes.has(idx) && !state.downloaded.has(idx)) {
                      if (!state.queue.includes(idx)) state.queue.unshift(idx)
                    }
                  }
                  notify()
                } catch (err) {
                  console.error(`Worker error at ${relayUrl}:`, err)
                  for (const idx of batch) {
                    const fetchingRelays = state.fetching.get(idx)
                    if (fetchingRelays) {
                      fetchingRelays.delete(relayUrl)
                      if (fetchingRelays.size === 0) state.fetching.delete(idx)
                    }
                    if (!state.downloaded.has(idx) && !state.queue.includes(idx)) {
                      state.queue.unshift(idx)
                    }
                  }
                  notify()

                  const currentBackoff = state.relayBackoffs.get(relayUrl) || 1000
                  const nextBackoff = Math.min(currentBackoff * 2, 30000) // Caps at 30 seconds
                  state.relayBackoffs.set(relayUrl, nextBackoff)

                  await new Promise(resolve => setTimeout(resolve, currentBackoff))
                }
              }
            } finally {
              notify()
            }
          })()
        })
      }

      yield reportProgress()

      while (true) {
        const lastVersion = state.version
        if (state.error) {
          yield reportProgress()
          return
        }

        if (state.total !== null && state.downloaded.size >= state.total) {
          yield { progress: 100, error: null }
          return
        }

        // Connectivity/Availability check
        if (state.total !== null && state.downloaded.size < state.total && state.fetching.size === 0) {
          const missingIndexes = []
          for (let i = 0; i < state.total; i++) {
            if (!state.downloaded.has(i)) missingIndexes.push(i)
          }

          if (missingIndexes.length > 0) {
            const canAnyRelayTry = missingIndexes.some(idx =>
              this.writeRelays.some(url => !state.missingByRelay.get(url)?.has(idx))
            )

            if (!canAnyRelayTry) {
              state.error = new Error('Chunks missing from all relays')
              notify()
              yield reportProgress()
              return
            }
          }
        }

        await wait(lastVersion)
        yield reportProgress()
      }
    } finally {
      state.instances--
      if (state.instances === 0) {
        state.stopped = true
        notify()
        activeDownloads.delete(this.sharedKey)
      }
    }
  }

  async _initState (state, { _countFileChunksFromDb, _getFileChunksFromDb }) {
    const dbInfo = await _countFileChunksFromDb(this.appId, this.fileRootHash)
    if (dbInfo.total) state.total = dbInfo.total

    const keys = await _getFileChunksFromDb(this.appId, this.fileRootHash, { justKeys: true })
    for (const key of keys) {
      // key is [appId, rootHash, pos]
      state.downloaded.add(key[2])
    }
  }

  async _fetchFromRelay (relayUrl, indexes, state, { _nostrRelays, _saveFileChunksToDB }) {
    const { pubkey } = appIdToAddressObj(this.appId)
    const filter = {
      kinds: [34600],
      authors: [pubkey],
      '#c': indexes.map(i => `${this.fileRootHash}:${i}`)
    }

    const { result } = await _nostrRelays.getEvents(filter, [relayUrl])

    const foundIndexes = new Set()
    const fakeBundle = { tags: [['file', this.fileRootHash]] }

    if (result && result.length > 0) {
      await _saveFileChunksToDB(fakeBundle, result, this.appId)

      for (const event of result) {
        const cTag = event.tags.find(t => t[0] === 'c' && t[1].startsWith(`${this.fileRootHash}:`))
        if (cTag) {
          const parts = cTag[1].split(':')
          const idx = parseInt(parts[1])
          foundIndexes.add(idx)
          state.downloaded.add(idx)

          if (state.total === null && cTag[2]) {
            state.total = parseInt(cTag[2])
          }
        }
      }
    }

    for (const idx of indexes) {
      const fetchingRelays = state.fetching.get(idx)
      if (fetchingRelays) {
        fetchingRelays.delete(relayUrl)
        if (fetchingRelays.size === 0) state.fetching.delete(idx)
      }

      if (!foundIndexes.has(idx)) {
        if (!state.missingByRelay.has(relayUrl)) state.missingByRelay.set(relayUrl, new Set())
        state.missingByRelay.get(relayUrl).add(idx)
      }
    }

    return foundIndexes
  }
}
