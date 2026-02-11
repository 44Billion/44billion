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
        stopped: false,
        queuePopulatedIndex: 0,
        chunkLog: []
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

    const getContiguousRanges = (indexes) => {
      if (indexes.length === 0) return []
      const sorted = [...indexes].sort((a, b) => a - b)
      const ranges = []
      let start = sorted[0]
      let end = sorted[0]

      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === end) continue
        if (sorted[i] === end + 1) {
          end = sorted[i]
        } else {
          ranges.push([start, end])
          start = end = sorted[i]
        }
      }
      ranges.push([start, end])
      return ranges
    }

    try {
      await state.initPromise
      let localLogIndex = 0

      const reportProgress = () => {
        const progress = state.total ? Math.floor((state.downloaded.size / state.total) * 100) : 0
        const newChunks = state.chunkLog.slice(localLogIndex)
        localLogIndex = state.chunkLog.length
        return {
          progress,
          error: state.error,
          newlyCachedChunkIndexRanges: getContiguousRanges(newChunks)
        }
      }

      if (!state.workersStarted) {
        state.workersStarted = true
        const batchSize = 20

        const ensureQueueFilled = () => {
          if (state.total === null) {
            if (!state.downloaded.has(0) && !state.fetching.has(0) && !state.queue.includes(0)) {
              state.queue.push(0)
            }
          } else if (state.queuePopulatedIndex < state.total) {
            for (let i = state.queuePopulatedIndex; i < state.total; i++) {
              if (i === 0 && (state.downloaded.has(0) || state.fetching.has(0) || state.queue.includes(0))) continue
              if (!state.downloaded.has(i)) {
                state.queue.push(i)
              }
            }
            state.queuePopulatedIndex = state.total
          }
        }

        this.writeRelays.forEach(relayUrl => {
          (async () => {
            try {
              while (true) {
                const lastVersion = state.version
                if (state.error || state.stopped || (state.total !== null && state.downloaded.size >= state.total)) break

                ensureQueueFilled()
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
                if (batch.length < batchSize) {
                  // Try stealing chunks that are being fetched by others but not by this relay
                  for (const idx of state.fetching.keys()) {
                    if (batch.length >= batchSize) break
                    if (state.downloaded.has(idx) || batch.includes(idx)) continue
                    if (state.missingByRelay.get(relayUrl)?.has(idx)) continue
                    // Steal even if in state.fetching (by others)
                    batch.push(idx)
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
                  const foundIndexes = await this._fetchFromRelay(relayUrl, batch, state, notify, deps)
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
    const newLogChunk = []
    for (const key of keys) {
      // key is [appId, rootHash, pos]
      if (!state.downloaded.has(key[2])) {
        state.downloaded.add(key[2])
        newLogChunk.push(key[2])
      }
    }
    if (newLogChunk.length > 0) {
      state.chunkLog.push(...newLogChunk)
    }
  }

  async _fetchFromRelay (relayUrl, indexes, state, notify, { _nostrRelays, _saveFileChunksToDB }) {
    const { pubkey } = appIdToAddressObj(this.appId)
    const filter = {
      kinds: [34600],
      authors: [pubkey],
      '#c': indexes.map(i => `${this.fileRootHash}:${i}`)
    }

    const generator = _nostrRelays.getEventsGenerator(filter, [relayUrl])

    const foundIndexes = new Set()
    const fakeBundle = { tags: [['file', this.fileRootHash]] }
    let error = null

    for await (const msg of generator) {
      if (msg.type === 'event') {
        const event = msg.event
        await _saveFileChunksToDB(fakeBundle, [event], this.appId)

        const cTag = event.tags.find(t => t[0] === 'c' && t[1].startsWith(`${this.fileRootHash}:`))
        if (cTag) {
          const parts = cTag[1].split(':')
          const idx = parseInt(parts[1])
          foundIndexes.add(idx)
          if (!state.downloaded.has(idx)) {
            state.downloaded.add(idx)
            state.chunkLog.push(idx)
          }

          if (state.total === null && cTag[2]) {
            state.total = parseInt(cTag[2])
          }
          if (notify) notify()
        }
      } else if (msg.type === 'error') {
        error = msg.error
      }
    }

    if (error) throw error

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
