import { appIdToAddressObj } from '#helpers/app.js'
import { getUserRelays, getEventsByStrategy } from '#helpers/nostr-queries.js'
import nostrRelays from '#services/nostr-relays.js'
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
    this.writeRelays = writeRelays
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
        fetching: new Set(),
        missingByRelay: new Map(), // relay -> Set(indexes)
        error: null,
        instances: 0,
        initPromise: null
      }
      state.initPromise = this._initState(state, deps)
      activeDownloads.set(this.sharedKey, state)
    }
    state.instances++

    try {
      await state.initPromise

      const reportProgress = () => {
        const progress = state.total ? Math.floor((state.downloaded.size / state.total) * 100) : 0
        return { progress, error: state.error }
      }

      yield reportProgress()

      while (true) {
        if (state.error) {
          yield reportProgress()
          return
        }

        if (state.total !== null && state.downloaded.size >= state.total) {
          yield { progress: 100, error: null }
          return
        }

        // Determine what to fetch
        const needed = []
        if (state.total === null) {
          if (!state.downloaded.has(0) && !state.fetching.has(0)) {
            needed.push(0)
          }
        } else {
          for (let i = 0; i < state.total; i++) {
            if (!state.downloaded.has(i) && !state.fetching.has(i)) {
              needed.push(i)
            }
          }
        }

        if (needed.length === 0) {
          if (state.total === null && state.fetching.size > 0) {
            // Waiting for chunk 0 to determine total
            await new Promise(resolve => setTimeout(resolve, 100))
            continue
          }
          if (state.total !== null && state.downloaded.size < state.total && state.fetching.size > 0) {
            // Waiting for other fetches
            await new Promise(resolve => setTimeout(resolve, 100))
            continue
          }

          if (state.total === null) {
            state.error = new Error('Could not find file metadata (chunk 0)')
            yield reportProgress()
            return
          }
          if (state.downloaded.size < state.total) {
            // Should be handled by relayAssignments check below, but just in case
          }
        }

        // Distribute chunks to relays
        const batchSize = 20
        const relayAssignments = new Map() // relay -> [indexes]

        const maxAssignment = this.writeRelays.length * batchSize
        const chunksToAssign = needed.slice(0, maxAssignment)

        for (const chunkIndex of chunksToAssign) {
          for (let offset = 0; offset < this.writeRelays.length; offset++) {
            const relayIdx = (chunkIndex + offset) % this.writeRelays.length
            const relayUrl = this.writeRelays[relayIdx]

            if (state.missingByRelay.get(relayUrl)?.has(chunkIndex)) continue

            if (!relayAssignments.has(relayUrl)) relayAssignments.set(relayUrl, [])
            const assignments = relayAssignments.get(relayUrl)

            if (assignments.length < batchSize) {
              assignments.push(chunkIndex)
              state.fetching.add(chunkIndex)
              break
            }
          }
        }

        if (relayAssignments.size === 0) {
          if (state.fetching.size > 0) {
            await new Promise(resolve => setTimeout(resolve, 100))
            continue
          }
          state.error = new Error('Chunks missing from all relays')
          yield reportProgress()
          return
        }

        // Execute fetches
        const promises = []
        for (const [relayUrl, indexes] of relayAssignments) {
          promises.push(this._fetchFromRelay(relayUrl, indexes, state, deps))
        }

        await Promise.all(promises)
        yield reportProgress()
      }
    } finally {
      state.instances--
      if (state.instances === 0) {
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

    try {
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
        state.fetching.delete(idx)
        if (!foundIndexes.has(idx)) {
          if (!state.missingByRelay.has(relayUrl)) state.missingByRelay.set(relayUrl, new Set())
          state.missingByRelay.get(relayUrl).add(idx)
        }
      }
    } catch (err) {
      console.error(`Error fetching from ${relayUrl}`, err)
      for (const idx of indexes) {
        state.fetching.delete(idx)
      }
    }
  }
}
