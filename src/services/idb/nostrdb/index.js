import { sha256 } from '@noble/hashes/sha2.js'

import { base16ToBase64, bytesToBase64 } from '#helpers/base64.js'
import { run } from '#services/idb/browser/index.js'
import {
  SEARCH_BATCH_SIZE,
  SEARCH_MATCH_MULTIPLIER,
  SEARCH_MAX_BATCHES,
  SEARCH_MAX_CANDIDATES,
  SEARCH_MAX_MATCHES,
  SEARCH_MIN_BATCHES,
  SEARCH_MIN_MATCHES,
  eventMatchesSearch,
  getSearchableText,
  matchSearchCandidates,
  parseSearch,
  rankSearchCandidates
} from './search.js'

export const NOSTRDB_VERSION = 1
export const NOSTRDB_PREFIX = '44billion_nostrdb:'
export const EVENTS_STORE = 'events'
export const DELETIONS_STORE = 'deletions'

/*
IndexedDB schema, scoped per owner DB name:

events, keyPath "ref"
  ref   "e:<base64url-id>" or "c:<base64url-sha256-coordinate>"
  i     base64url event id bytes
  p     base64url pubkey bytes
  k     event kind
  ca    created_at timestamp
  t     multiEntry tag index keys: [tagName, sha256(tagValue), created_at]
  event original Nostr event

events indexes
  byId         i, unique
  byCreatedAt ca
  byPubkey    [p, ca]
  byKind      [k, ca]
  byPubkeyKind [p, k, ca]
  byTag       t, multiEntry

deletions, keyPath "ref"
  ref   "e:<base64url-id>:<base64url-pubkey>" or "a:<base64url-sha256-coordinate>"
  tag   deletion target tag to preserve when compacting: ["e", id] or ["a", address]
  ca    max created_at among stored deletion requests contributing this tombstone
  c     multiEntry contributors: [requestIdKey, requestCreatedAt]

deletions indexes
  byRequest c, multiEntry
*/
export const INDEX = {
  id: 'byId',
  createdAt: 'byCreatedAt',
  pubkey: 'byPubkey',
  kind: 'byKind',
  pubkeyKind: 'byPubkeyKind',
  tag: 'byTag'
}

export const DELETION_INDEX = {
  request: 'byRequest'
}

const HEX64_RE = /^[0-9a-f]{64}$/i
const SIG_RE = /^[0-9a-f]{128}$/i
const textEncoder = new TextEncoder()
const dbCache = new Map()
const storeCache = new Map()

export function getNostrDb (ownerPubkey) {
  if (!storeCache.has(ownerPubkey)) {
    storeCache.set(ownerPubkey, new NostrDb(ownerPubkey))
  }
  return storeCache.get(ownerPubkey)
}

export class NostrDb {
  constructor (ownerPubkey) {
    this.ownerPubkey = ownerPubkey
    this.sender = `${Date.now()}:${Math.random()}`
    this.subscriptions = new Set()
    this.bc = null

    if (typeof BroadcastChannel === 'function') {
      this.bc = new BroadcastChannel(channelName(ownerPubkey))
      this.bc.unref?.()
      this.bc.onmessage = ({ data }) => {
        if (data?.type !== 'event' || data.sender === this.sender) return
        this.publish(data.event, false)
      }
    }
  }

  async add (event) {
    const saved = await this.addEvent(event)
    if (saved) this.publish(event, true)
    return saved
  }

  async addEvent (event, { consumeDeletionRequestIds = [] } = {}) {
    if (!isValidEventShape(event)) return false

    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return false

    const record = toStoredRecord(event)

    try {
      const tx = db.transaction([EVENTS_STORE, DELETIONS_STORE], 'readwrite')
      const done = txDone(tx)

      const existingById = await run('get', [record.i], EVENTS_STORE, INDEX.id, { db, tx })
        .then(v => v.result)

      if (existingById) {
        await done
        return false
      }

      if (await isBlockedByDeletion(db, tx, event)) {
        await done
        return false
      }

      if (record.ref.startsWith('c:')) {
        const existingByRef = await run('get', [record.ref], EVENTS_STORE, null, { db, tx })
          .then(v => v.result)

        if (existingByRef && !isNewer(event, existingByRef.event)) {
          await done
          return false
        }
      }

      if (event.kind === 5) {
        // Keep this chain IDB-only; unrelated awaits can let the transaction auto-commit.
        await applyDeletionRequest(db, tx, event, record.ref)
      }

      for (const id of consumeDeletionRequestIds) {
        await deleteStoredDeletionRequestById(db, tx, id, event.pubkey)
      }

      await run('put', [record], EVENTS_STORE, null, { db, tx })
      await done
    } catch {
      return false
    }

    return true
  }

  async compactDeletionRequests ({
    sign,
    author = this.ownerPubkey,
    maxTargetRefs = 1000,
    createdAt,
    signal
  } = {}) {
    if (typeof sign !== 'function') throw new TypeError('compactDeletionRequests requires a sign function')
    if (!HEX64_RE.test(author)) return compactResult()

    throwIfAborted(signal)

    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return compactResult()

    const maxRefs = Number.isInteger(maxTargetRefs) && maxTargetRefs > 0 ? maxTargetRefs : 1000
    let requests
    let infos

    try {
      requests = await queryRecords(db, { authors: [author], kinds: [5] }, {
        countOnly: false,
        ignoreLimit: true
      })
      requests.sort(compareOldest)

      if (requests.length < 2) return compactResult()

      const tx = db.transaction([DELETIONS_STORE], 'readonly')
      const done = txDone(tx)
      infos = []

      for (const request of requests) {
        throwIfAborted(signal)

        const rows = await getDeletionRowsForRequest(db, tx, eventIdIndexKey(request.id))
        const targets = uniqueDeletionRows(rows)
        if (targets.length > 0) infos.push({ event: request, targets })
      }

      await done
    } catch {
      throwIfAborted(signal)
      return compactResult()
    }

    const selected = []
    const targets = new Map()

    for (const info of infos) {
      const newRefs = info.targets.filter(row => !targets.has(row.ref))
      if (targets.size + newRefs.length > maxRefs) continue

      selected.push(info)
      for (const row of info.targets) {
        if (!targets.has(row.ref)) targets.set(row.ref, row)
      }
    }

    if (selected.length < 2 || targets.size === 0) return compactResult()

    const consumed = selected.map(info => info.event.id)
    const maxConsumedCreatedAt = Math.max(...selected.map(info => info.event.created_at))
    const templateCreatedAt = Math.max(
      normalizeTimestamp(createdAt, Math.floor(Date.now() / 1000)),
      maxConsumedCreatedAt
    )
    const tags = [...targets.values()].map(row => [...row.tag])
    const template = {
      kind: 5,
      created_at: templateCreatedAt,
      tags: tags.map(tag => [...tag]),
      content: ''
    }

    throwIfAborted(signal)
    const signed = await sign(template)
    throwIfAborted(signal)

    if (
      !isValidEventShape(signed) ||
      signed.kind !== 5 ||
      signed.pubkey !== author ||
      signed.created_at < maxConsumedCreatedAt ||
      signed.content !== '' ||
      !sameTags(signed.tags, tags)
    ) {
      return compactResult()
    }

    const saved = await this.addEvent(signed, { consumeDeletionRequestIds: consumed })
    if (!saved) return compactResult()

    this.publish(signed, true)
    return compactResult({ compacted: true, created: signed, consumed, targets: tags })
  }

  startDeletionCompaction ({
    intervalMs = 3600000,
    runImmediately = true,
    ...options
  } = {}) {
    const delay = Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : 3600000
    let stopped = false
    let running = false
    let timer = null

    const schedule = ms => {
      if (stopped) return
      timer = setTimeout(tick, ms)
      timer.unref?.()
    }

    const tick = async () => {
      if (stopped) return
      if (running) {
        schedule(delay)
        return
      }

      running = true
      try {
        await this.compactDeletionRequests(options)
      } catch {
      } finally {
        running = false
        schedule(delay)
      }
    }

    schedule(runImmediately ? 0 : delay)

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }

  async query (filter) {
    assertSingleFilter(filter)

    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return []

    try {
      return await queryRecords(db, filter, { countOnly: false, ignoreLimit: false })
    } catch {
      return []
    }
  }

  async count (filter) {
    assertSingleFilter(filter)

    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return 0

    try {
      return await queryRecords(db, filter, { countOnly: true, ignoreLimit: false })
    } catch {
      return 0
    }
  }

  async supports () {
    return ['search']
  }

  async deleteDb () {
    this.bc?.close()
    this.bc = null
    return deleteNostrDb(this.ownerPubkey)
  }

  subscribe (filter) {
    assertSingleFilter(filter)

    const parsed = new ParsedFilter(filter)
    const subscription = createSubscription(parsed)
    this.subscriptions.add(subscription)

    return subscription.iterator(() => {
      this.subscriptions.delete(subscription)
    })
  }

  publish (event, shouldBroadcast) {
    for (const subscription of this.subscriptions) {
      subscription.push(event)
    }

    if (shouldBroadcast) {
      this.bc?.postMessage({ type: 'event', sender: this.sender, event })
    }
  }
}

export async function openNostrDb (ownerPubkey) {
  if (typeof indexedDB === 'undefined') return null

  const dbName = `${NOSTRDB_PREFIX}${ownerPubkey}`
  if (!dbCache.has(dbName)) {
    dbCache.set(dbName, initNostrDb(dbName).catch(() => null))
  }
  return dbCache.get(dbName)
}

export async function deleteNostrDb (ownerPubkey) {
  if (typeof indexedDB === 'undefined') return false

  const dbName = `${NOSTRDB_PREFIX}${ownerPubkey}`
  const store = storeCache.get(ownerPubkey)
  store?.bc?.close()
  if (store) store.bc = null
  storeCache.delete(ownerPubkey)

  const cached = dbCache.get(dbName)
  dbCache.delete(dbName)

  try {
    const db = await cached
    db?.close()
  } catch {}

  return new Promise(resolve => {
    let req

    try {
      req = indexedDB.deleteDatabase(dbName)
    } catch {
      resolve(false)
      return
    }

    req.onsuccess = () => resolve(true)
    req.onerror = () => resolve(false)
    req.onblocked = () => resolve(false)
  })
}

function initNostrDb (dbName) {
  const p = Promise.withResolvers()
  let req

  try {
    req = indexedDB.open(dbName, NOSTRDB_VERSION)
  } catch {
    return Promise.resolve(null)
  }

  req.onerror = () => p.resolve(null)
  req.onblocked = () => p.resolve(null)
  req.onsuccess = () => {
    const db = req.result
    db.onversionchange = () => {
      db.close()
      dbCache.delete(dbName)
    }
    p.resolve(db)
  }
  req.onupgradeneeded = e => {
    const db = e.target.result
    const tx = e.target.transaction
    let store

    store = createObjectStoreIfMissing(db, tx, EVENTS_STORE, { keyPath: 'ref' })
    createIndexIfMissing(store, INDEX.id, 'i', { unique: true })
    createIndexIfMissing(store, INDEX.createdAt, 'ca')
    createIndexIfMissing(store, INDEX.pubkey, ['p', 'ca'])
    createIndexIfMissing(store, INDEX.kind, ['k', 'ca'])
    createIndexIfMissing(store, INDEX.pubkeyKind, ['p', 'k', 'ca'])
    createIndexIfMissing(store, INDEX.tag, 't', { multiEntry: true })

    store = createObjectStoreIfMissing(db, tx, DELETIONS_STORE, { keyPath: 'ref' })
    createIndexIfMissing(store, DELETION_INDEX.request, 'c', { multiEntry: true })
  }

  return p.promise
}

function createObjectStoreIfMissing (db, tx, name, options) {
  return db.objectStoreNames.contains(name)
    ? tx.objectStore(name)
    : db.createObjectStore(name, options)
}

function createIndexIfMissing (store, name, keyPath, options) {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath, options)
  }
}

const MAX_LIMIT = 200
async function queryRecords (db, rawFilter, { countOnly, ignoreLimit }) {
  const filter = new ParsedFilter(rawFilter)
  if (filter.neverMatch) return countOnly ? 0 : []

  const limit = ignoreLimit ? Infinity : Math.min(countOnly ? Infinity : MAX_LIMIT, filter.limit)
  if (limit <= 0) return countOnly ? 0 : []

  const plan = planQuery(filter)
  const direction = filter.sortOld ? 'next' : 'prev'

  if (filter.searchText) {
    const candidates = await collectSearchCandidates(db, plan, filter, direction, { countOnly, limit })

    if (countOnly) return Number.isFinite(limit) ? Math.min(candidates.length, limit) : candidates.length

    const ranked = rankSearchCandidates(candidates, filter, compareSearchTime)
    return ranked
      .slice(0, Number.isFinite(limit) ? limit : ranked.length)
      .map(candidate => candidate.event)
  }

  const seen = new Set()
  const results = []
  let count = 0

  const matches = stored => stored && filter.matches(stored.event)
  const emit = stored => {
    if (!matches(stored) || seen.has(stored.event.id)) return false
    seen.add(stored.event.id)
    count++
    if (!countOnly) results.push(stored.event)
    return true
  }

  if (plan.type === 'direct') {
    for (const cursor of plan.cursors) {
      const stored = await run('get', [cursor.key], EVENTS_STORE, cursor.indexName, { db })
        .then(v => v.result)
      if (emit(stored) && countOnly && count >= limit) break
    }
  } else {
    for (const cursor of plan.cursors) {
      let matchedInCursor = 0

      for await (const stored of streamCursor(db, EVENTS_STORE, cursor.indexName, cursor.range, {
        direction
      })) {
        if (!matches(stored)) continue
        matchedInCursor++
        emit(stored)
        if (countOnly && count >= limit) break
        if (!countOnly && matchedInCursor >= limit) break
      }
      if (countOnly && count >= limit) break
    }
  }

  if (countOnly) return count

  results.sort(filter.sortOld ? compareOldest : compareNewest)
  return Number.isFinite(limit) ? results.slice(0, limit) : results
}

async function * streamCursor (db, storeName, indexName, range, { tx, direction = 'next' } = {}) {
  const p = Promise.withResolvers()
  await run('openCursor', [range, direction], storeName, indexName, { db, p, tx })

  let cursor
  while ((cursor = (await p.promise).result)) {
    yield cursor.value
    Object.assign(p, Promise.withResolvers())
    cursor.continue()
  }
}

// IDB scanning stays here because it knows about plans, stores, cursors, and caps.
async function collectSearchCandidates (db, plan, filter, direction, { countOnly, limit }) {
  const matches = []
  const seen = new Set()
  const matchTarget = searchMatchTarget(countOnly, limit)

  const toCandidate = stored => {
    if (!stored || seen.has(stored.event.id) || !filter.matchesStructured(stored.event)) return null
    seen.add(stored.event.id)

    const text = getSearchableText(stored.event)
    return text ? { event: stored.event, text } : null
  }

  if (plan.type === 'direct') {
    const candidates = []
    let scanned = 0

    for (const cursor of plan.cursors) {
      if (scanned >= SEARCH_MAX_CANDIDATES) break

      const stored = await run('get', [cursor.key], EVENTS_STORE, cursor.indexName, { db })
        .then(v => v.result)
      scanned++
      const candidate = toCandidate(stored)
      if (candidate) candidates.push(candidate)
    }

    return matchSearchCandidates(candidates, filter)
  }

  const states = plan.cursors.map(cursor => ({
    done: false,
    iterator: streamCursor(db, EVENTS_STORE, cursor.indexName, cursor.range, { direction })[Symbol.asyncIterator]()
  }))
  let scanned = 0

  for (let batch = 0; batch < SEARCH_MAX_BATCHES && scanned < SEARCH_MAX_CANDIDATES; batch++) {
    const batchCandidates = []
    let scannedInBatch = 0

    while (
      scannedInBatch < SEARCH_BATCH_SIZE &&
      scanned < SEARCH_MAX_CANDIDATES &&
      states.some(state => !state.done)
    ) {
      let progressed = false

      for (const state of states) {
        if (state.done) continue

        const next = await state.iterator.next()
        if (next.done) {
          state.done = true
          continue
        }

        progressed = true
        scanned++
        scannedInBatch++
        const candidate = toCandidate(next.value)
        if (candidate) batchCandidates.push(candidate)

        if (scannedInBatch >= SEARCH_BATCH_SIZE || scanned >= SEARCH_MAX_CANDIDATES) break
      }

      if (!progressed) break
    }

    if (scannedInBatch === 0) break

    matches.push(...matchSearchCandidates(batchCandidates, filter))
    if (shouldStopSearch(countOnly, batch + 1, matches.length, matchTarget)) break
  }

  return matches
}

function compareSearchTime (a, b, filter) {
  return filter.sortOld ? compareOldest(a, b) : compareNewest(a, b)
}

function searchMatchTarget (countOnly, limit) {
  if (countOnly) return Number.isFinite(limit) ? limit : Infinity

  return Math.min(
    SEARCH_MAX_MATCHES,
    Math.max(SEARCH_MIN_MATCHES, limit * SEARCH_MATCH_MULTIPLIER)
  )
}

function shouldStopSearch (countOnly, batchCount, matchCount, matchTarget) {
  if (!Number.isFinite(matchTarget)) return false
  if (countOnly) return matchCount >= matchTarget

  return batchCount >= SEARCH_MIN_BATCHES && matchCount >= matchTarget
}

export function planQuery (filter) {
  if (filter.ids) {
    return {
      type: 'direct',
      cursors: filter.ids.map(id => ({ indexName: INDEX.id, key: eventIdIndexKey(id) }))
    }
  }

  const coordinateCursors = getCoordinateCursors(filter)
  if (coordinateCursors) {
    return { type: 'direct', cursors: coordinateCursors }
  }

  const replaceableCursors = getReplaceableCursors(filter)
  if (replaceableCursors) {
    return { type: 'direct', cursors: replaceableCursors }
  }

  if (filter.tags.length > 0) {
    const tag = filter.tags.reduce((a, b) => (b.values.length < a.values.length ? b : a))
    return {
      type: 'cursor',
      cursors: tag.values.map(value => ({
        indexName: INDEX.tag,
        range: IDBKeyRange.bound(
          [tag.name, tagValueIndexKey(value), filter.since],
          [tag.name, tagValueIndexKey(value), filter.until]
        )
      }))
    }
  }

  if (filter.authors && filter.kinds) {
    const cursors = []
    for (const author of filter.authors) {
      for (const kind of filter.kinds) {
        cursors.push({
          indexName: INDEX.pubkeyKind,
          range: IDBKeyRange.bound(
            [pubkeyIndexKey(author), kind, filter.since],
            [pubkeyIndexKey(author), kind, filter.until]
          )
        })
      }
    }
    return { type: 'cursor', cursors }
  }

  if (filter.authors) {
    return {
      type: 'cursor',
      cursors: filter.authors.map(author => ({
        indexName: INDEX.pubkey,
        range: IDBKeyRange.bound(
          [pubkeyIndexKey(author), filter.since],
          [pubkeyIndexKey(author), filter.until]
        )
      }))
    }
  }

  if (filter.kinds) {
    return {
      type: 'cursor',
      cursors: filter.kinds.map(kind => ({
        indexName: INDEX.kind,
        range: IDBKeyRange.bound([kind, filter.since], [kind, filter.until])
      }))
    }
  }

  return {
    type: 'cursor',
    cursors: [{
      indexName: INDEX.createdAt,
      range: IDBKeyRange.bound(filter.since, filter.until)
    }]
  }
}

function getCoordinateCursors (filter) {
  if (!filter.authors || !filter.kinds || !filter.dtags) return null
  if (!filter.kinds.every(kindUsesDCoordinate)) return null

  const cursors = []
  for (const author of filter.authors) {
    for (const kind of filter.kinds) {
      for (const dtag of filter.dtags) {
        cursors.push({ key: coordinateRef(kind, author, dtag) })
      }
    }
  }
  return cursors
}

function getReplaceableCursors (filter) {
  if (!filter.authors || !filter.kinds || filter.dtags) return null
  if (!filter.kinds.every(isRegularReplaceableKind)) return null

  const cursors = []
  for (const author of filter.authors) {
    for (const kind of filter.kinds) {
      cursors.push({ key: coordinateRef(kind, author, '') })
    }
  }
  return cursors
}

function createSubscription (filter) {
  const queue = []
  const waiters = []
  let closed = false

  return {
    push (event) {
      if (closed || !filter.matches(event)) return
      if (waiters.length > 0) {
        waiters.shift().resolve({ value: event, done: false })
      } else {
        queue.push(event)
      }
    },
    iterator (onClose) {
      return {
        [Symbol.asyncIterator] () {
          return this
        },
        next () {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false })
          }
          if (closed) return Promise.resolve({ done: true })

          const p = Promise.withResolvers()
          waiters.push(p)
          return p.promise
        },
        return () {
          closed = true
          onClose()
          while (waiters.length > 0) {
            waiters.shift().resolve({ done: true })
          }
          return Promise.resolve({ done: true })
        }
      }
    }
  }
}

export class ParsedFilter {
  constructor (filter) {
    this.ids = undefined
    this.authors = undefined
    this.kinds = undefined
    this.dtags = undefined
    this.tags = []
    this.since = 0
    this.until = Infinity
    this.limit = Infinity
    this.neverMatch = false
    this.sortOld = false
    this.autocomplete = false
    this.searchText = ''

    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      this.neverMatch = true
      return
    }

    for (const [key, value] of Object.entries(filter)) {
      if (Array.isArray(value) && value.length === 0) {
        this.neverMatch = true
        continue
      }

      if (key === 'ids') {
        this.ids = normalizeStringArray(value, HEX64_RE)
      } else if (key === 'authors') {
        this.authors = normalizeStringArray(value, HEX64_RE)
      } else if (key === 'kinds') {
        this.kinds = normalizeNumberArray(value)
      } else if (key === 'since') {
        this.since = normalizeTimestamp(value, 0)
      } else if (key === 'until') {
        this.until = normalizeTimestamp(value, Infinity)
      } else if (key === 'limit') {
        this.limit = normalizeLimit(value)
      } else if (key === 'search') {
        const search = parseSearch(value)
        this.sortOld = search.sortOld
        this.autocomplete = search.autocomplete
        this.searchText = search.text
      } else if (key.startsWith('#') && key.length >= 2) {
        const values = normalizeTagValues(value)
        const tag = { name: key.slice(1), values }
        this.tags.push(tag)
        if (key === '#d') this.dtags = values
      }
    }

    if (
      this.ids?.length === 0 ||
      this.authors?.length === 0 ||
      this.kinds?.length === 0 ||
      this.dtags?.length === 0 ||
      this.tags.some(tag => tag.values.length === 0)
    ) {
      this.neverMatch = true
    }
  }

  matches (event) {
    if (!this.matchesStructured(event)) return false
    if (this.searchText && !eventMatchesSearch(event, this, compareSearchTime)) return false

    return true
  }

  matchesStructured (event) {
    if (this.neverMatch) return false
    if (event.created_at < this.since || event.created_at > this.until) return false
    if (this.ids && !this.ids.includes(event.id)) return false
    if (this.authors && !this.authors.includes(event.pubkey)) return false
    if (this.kinds && !this.kinds.includes(event.kind)) return false

    for (const { name, values } of this.tags) {
      if (!event.tags.some(tag => tag[0] === name && values.includes(tag[1]))) return false
    }

    return true
  }
}

export function toStoredRecord (event) {
  const coordinate = getCoordinate(event)
  return {
    ref: coordinate === null ? eventRef(event.id) : coordinateRef(event.kind, event.pubkey, coordinate),
    i: eventIdIndexKey(event.id),
    p: pubkeyIndexKey(event.pubkey),
    k: event.kind,
    ca: event.created_at,
    t: tagIndexKeys(event),
    event
  }
}

export function getCoordinate (event) {
  if (isRegularReplaceableKind(event.kind)) return ''
  if (isAddressableKind(event.kind)) return getDTag(event) ?? ''
  return getDTag(event)
}

export function eventRef (id) {
  return `e:${eventIdIndexKey(id)}`
}

export function coordinateRef (kind, pubkey, dtag) {
  return `c:${coordinateHash(kind, pubkey, dtag)}`
}

export function deletionEventRef (id, pubkey) {
  return `e:${eventIdIndexKey(id)}:${pubkeyIndexKey(pubkey)}`
}

export function deletionCoordinateRef (kind, pubkey, dtag) {
  return `a:${coordinateHash(kind, pubkey, dtag)}`
}

function coordinateHash (kind, pubkey, dtag) {
  return bytesToBase64(sha256(textEncoder.encode(`${kind}:${pubkey}:${dtag}`)))
}

export function eventIdIndexKey (id) {
  return base16ToBase64(id)
}

export function pubkeyIndexKey (pubkey) {
  return base16ToBase64(pubkey)
}

export function tagValueIndexKey (value) {
  return bytesToBase64(sha256(textEncoder.encode(value)))
}

export function tagIndexKeys (event) {
  const seen = new Set()
  const keys = []

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || typeof tag[0] !== 'string' || typeof tag[1] !== 'string') continue
    if (tag[0].length !== 1) continue

    const dedupeKey = `${tag[0]}\u0000${tag[1]}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    keys.push([tag[0], tagValueIndexKey(tag[1]), event.created_at])
  }

  return keys
}

export function isNewer (event, other) {
  if (event.created_at > other.created_at) return true
  if (event.created_at < other.created_at) return false
  return event.id < other.id
}

export function isValidEventShape (event) {
  if (!event || typeof event !== 'object') return false
  if (!HEX64_RE.test(event.id)) return false
  if (!HEX64_RE.test(event.pubkey)) return false
  if (!SIG_RE.test(event.sig)) return false
  if (!Number.isInteger(event.kind) || event.kind < 0 || event.kind > 0xffff) return false
  if (!Number.isInteger(event.created_at) || event.created_at < 0 || event.created_at > 0xffffffff) return false
  if (!Array.isArray(event.tags)) return false
  if (typeof event.content !== 'string') return false

  return event.tags.every(tag => Array.isArray(tag) && tag.every(value => typeof value === 'string'))
}

async function isBlockedByDeletion (db, tx, event) {
  const eventDeletion = await run(
    'get',
    [deletionEventRef(event.id, event.pubkey)],
    DELETIONS_STORE,
    null,
    { db, tx }
  ).then(v => v.result)

  if (eventDeletion) return true

  const coordinate = getCoordinate(event)
  if (coordinate === null) return false

  const coordinateDeletion = await run(
    'get',
    [deletionCoordinateRef(event.kind, event.pubkey, coordinate)],
    DELETIONS_STORE,
    null,
    { db, tx }
  ).then(v => v.result)

  return !!coordinateDeletion && event.created_at <= coordinateDeletion.ca
}

async function applyDeletionRequest (db, tx, request, requestRef) {
  for (const tag of request.tags) {
    const target = deletionTargetFromTag(request, requestRef, tag)
    if (!target) continue

    await addDeletionContribution(db, tx, target, request)
    await deleteDeletionTarget(db, tx, request, requestRef, target)
  }
}

function deletionTargetFromTag (request, requestRef, tag) {
  if (tag[0] === 'e') {
    const id = tag[1]
    if (!HEX64_RE.test(id)) return null
    if (id === request.id) return null

    return {
      ref: deletionEventRef(id, request.pubkey),
      tag: ['e', id],
      type: 'e',
      id,
      upToCreatedAt: Infinity
    }
  }

  if (tag[0] !== 'a') return null

  const parsed = parseAddress(tag[1])
  if (!parsed || parsed.pubkey !== request.pubkey) return null
  if (coordinateRef(parsed.kind, parsed.pubkey, parsed.dtag) === requestRef) return null

  const address = `${parsed.kind}:${parsed.pubkey}:${parsed.dtag}`
  return {
    ref: deletionCoordinateRef(parsed.kind, parsed.pubkey, parsed.dtag),
    tag: ['a', address],
    type: 'a',
    kind: parsed.kind,
    pubkey: parsed.pubkey,
    dtag: parsed.dtag,
    upToCreatedAt: request.created_at
  }
}

async function addDeletionContribution (db, tx, target, request) {
  const requestIdKey = eventIdIndexKey(request.id)
  const existing = await run('get', [target.ref], DELETIONS_STORE, null, { db, tx })
    .then(v => v.result)
  const contributors = validContributors(existing?.c)
    .filter(contributor => contributor[0] !== requestIdKey)

  contributors.push([requestIdKey, request.created_at])
  contributors.sort(compareKeys)

  await run('put', [{
    ref: target.ref,
    tag: target.tag,
    ca: maxContributorCreatedAt(contributors),
    c: contributors
  }], DELETIONS_STORE, null, { db, tx })
}

async function deleteDeletionTarget (db, tx, request, requestRef, target) {
  let stored

  if (target.type === 'e') {
    stored = await run('get', [eventIdIndexKey(target.id)], EVENTS_STORE, INDEX.id, { db, tx })
      .then(v => v.result)
  } else {
    stored = await run(
      'get',
      [coordinateRef(target.kind, target.pubkey, target.dtag)],
      EVENTS_STORE,
      null,
      { db, tx }
    ).then(v => v.result)
  }

  await deleteMatchingTarget(db, tx, request, requestRef, stored, {
    upToCreatedAt: target.upToCreatedAt
  })
}

async function deleteMatchingTarget (db, tx, request, requestRef, target, { upToCreatedAt = Infinity } = {}) {
  if (!target || target.ref === requestRef) return
  if (target.event.pubkey !== request.pubkey) return
  if (target.event.created_at > upToCreatedAt) return

  await deleteStoredEvent(db, tx, target)
}

async function deleteStoredDeletionRequestById (db, tx, id, author) {
  if (!HEX64_RE.test(id)) return false

  const target = await run('get', [eventIdIndexKey(id)], EVENTS_STORE, INDEX.id, { db, tx })
    .then(v => v.result)

  if (!target || target.event.kind !== 5 || target.event.pubkey !== author) return false

  await deleteStoredEvent(db, tx, target)
  return true
}

async function deleteStoredEvent (db, tx, stored) {
  await run('delete', [stored.ref], EVENTS_STORE, null, { db, tx })

  if (stored.event.kind === 5) {
    await removeDeletionRequestContributions(db, tx, stored.i)
  }
}

async function removeDeletionRequestContributions (db, tx, requestIdKey) {
  const rows = await getDeletionRowsForRequest(db, tx, requestIdKey)

  for (const row of uniqueDeletionRows(rows)) {
    const contributors = validContributors(row.c)
      .filter(contributor => contributor[0] !== requestIdKey)

    if (contributors.length === 0) {
      await run('delete', [row.ref], DELETIONS_STORE, null, { db, tx })
    } else {
      await run('put', [{
        ...row,
        ca: maxContributorCreatedAt(contributors),
        c: contributors
      }], DELETIONS_STORE, null, { db, tx })
    }
  }
}

async function getDeletionRowsForRequest (db, tx, requestIdKey) {
  const range = IDBKeyRange.bound([requestIdKey, 0], [requestIdKey, 0xffffffff])
  const rows = []

  for await (const row of streamCursor(db, DELETIONS_STORE, DELETION_INDEX.request, range, { tx })) {
    rows.push(row)
  }

  return rows
}

function uniqueDeletionRows (rows) {
  return [...new Map(rows.map(row => [row.ref, row])).values()]
}

function validContributors (contributors) {
  if (!Array.isArray(contributors)) return []

  return contributors.filter(contributor => (
    Array.isArray(contributor) &&
    contributor.length === 2 &&
    typeof contributor[0] === 'string' &&
    Number.isInteger(contributor[1]) &&
    contributor[1] >= 0
  ))
}

function maxContributorCreatedAt (contributors) {
  return contributors.reduce((max, contributor) => Math.max(max, contributor[1]), 0)
}

function parseAddress (address) {
  if (typeof address !== 'string') return null

  const [kindStr, pubkey, ...dtagParts] = address.split(':')
  const kind = Number(kindStr)

  if (!Number.isInteger(kind) || kind < 0 || kind > 0xffff) return null
  if (!HEX64_RE.test(pubkey)) return null

  return { kind, pubkey, dtag: dtagParts.join(':') }
}

function normalizeStringArray (value, pattern) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(item => typeof item === 'string' && pattern.test(item)))].sort()
}

function normalizeNumberArray (value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(item => Number.isInteger(item) && item >= 0 && item <= 0xffff))]
    .sort((a, b) => a - b)
}

function normalizeTagValues (value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(item => typeof item === 'string'))].sort()
}

function normalizeTimestamp (value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function normalizeLimit (value) {
  return Number.isInteger(value) && value >= 0 ? value : Infinity
}

function assertSingleFilter (filter) {
  if (Array.isArray(filter)) throw new TypeError('nostrdb accepts a single filter object, not an array')
}

function compareNewest (a, b) {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function compareOldest (a, b) {
  if (a.created_at !== b.created_at) return a.created_at - b.created_at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function compareKeys (a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const compared = compareKeys(a[i], b[i])
      if (compared !== 0) return compared
    }
    return a.length - b.length
  }
  if (a === b) return 0
  return a < b ? -1 : 1
}

function sameTags (a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false

  return a.every((tag, index) => (
    Array.isArray(tag) &&
    tag.length === b[index].length &&
    tag.every((value, valueIndex) => value === b[index][valueIndex])
  ))
}

function compactResult ({
  compacted = false,
  created = null,
  consumed = [],
  targets = []
} = {}) {
  return { compacted, created, consumed, targets }
}

function throwIfAborted (signal) {
  if (!signal?.aborted) return
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted()
  throw new Error('operation aborted')
}

function txDone (tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'))
    tx.onerror = () => reject(tx.error || new Error('transaction failed'))
  })
}

function getDTag (event) {
  return event.tags.find(tag => tag[0] === 'd')?.[1] ?? null
}

function kindUsesDCoordinate (kind) {
  return !isRegularReplaceableKind(kind)
}

function isRegularReplaceableKind (kind) {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)
}

function isAddressableKind (kind) {
  return kind >= 30000 && kind < 40000
}

function channelName (ownerPubkey) {
  return `${NOSTRDB_PREFIX}${ownerPubkey}`
}

export const __nostrDbInternals = {
  channelName,
  compareNewest,
  getCoordinate,
  isAddressableKind,
  isRegularReplaceableKind,
  kindUsesDCoordinate
}
