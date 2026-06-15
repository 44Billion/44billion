import { sha256 } from '@noble/hashes/sha2.js'

import { base16ToBase64, bytesToBase64 } from '#helpers/base64.js'
import { run } from '#services/idb/browser/index.js'

export const NOSTRDB_VERSION = 1
export const NOSTRDB_PREFIX = '44billion_nostrdb:'
export const EVENTS_STORE = 'events'

export const INDEX = {
  id: 'byId',
  createdAt: 'byCreatedAt',
  pubkey: 'byPubkey',
  kind: 'byKind',
  pubkeyKind: 'byPubkeyKind',
  tag: 'byTag'
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
    if (!isValidEventShape(event)) return false

    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return false

    const record = toStoredRecord(event)

    try {
      const tx = db.transaction([EVENTS_STORE], 'readwrite')
      const done = txDone(tx)

      const existingById = await run('get', [record.i], EVENTS_STORE, INDEX.id, { db, tx })
        .then(v => v.result)

      if (existingById) {
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
      await run('put', [record], EVENTS_STORE, null, { db, tx })
      await done
    } catch {
      return false
    }

    this.publish(event, true)
    return true
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
      return await queryRecords(db, filter, { countOnly: true, ignoreLimit: true })
    } catch {
      return 0
    }
  }

  async supports () {
    return []
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

    if (!db.objectStoreNames.contains(EVENTS_STORE)) {
      store = db.createObjectStore(EVENTS_STORE, { keyPath: 'ref' })
    } else {
      store = tx.objectStore(EVENTS_STORE)
    }

    createIndexIfMissing(store, INDEX.id, 'i', { unique: true })
    createIndexIfMissing(store, INDEX.createdAt, 'ca')
    createIndexIfMissing(store, INDEX.pubkey, ['p', 'ca'])
    createIndexIfMissing(store, INDEX.kind, ['k', 'ca'])
    createIndexIfMissing(store, INDEX.pubkeyKind, ['p', 'k', 'ca'])
    createIndexIfMissing(store, INDEX.tag, 't', { multiEntry: true })
  }

  return p.promise
}

function createIndexIfMissing (store, name, keyPath, options) {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath, options)
  }
}

async function queryRecords (db, rawFilter, { countOnly, ignoreLimit }) {
  const filter = new ParsedFilter(rawFilter)
  if (filter.neverMatch) return countOnly ? 0 : []

  const limit = ignoreLimit ? Infinity : filter.limit
  if (limit <= 0) return countOnly ? 0 : []

  const plan = planQuery(filter)
  const seen = new Set()
  const results = []
  let count = 0

  const emit = stored => {
    if (!stored || seen.has(stored.event.id) || !filter.matches(stored.event)) return false
    seen.add(stored.event.id)
    count++
    if (!countOnly) results.push(stored.event)
    return count >= limit
  }

  if (plan.type === 'direct') {
    for (const cursor of plan.cursors) {
      const stored = await run('get', [cursor.key], EVENTS_STORE, cursor.indexName, { db })
        .then(v => v.result)
      if (emit(stored)) break
    }
  } else {
    for (const cursor of plan.cursors) {
      for await (const stored of streamCursor(db, cursor.indexName, cursor.range)) {
        if (emit(stored)) break
      }
      if (count >= limit) break
    }
  }

  if (countOnly) return count

  results.sort(compareNewest)
  return Number.isFinite(limit) ? results.slice(0, limit) : results
}

async function * streamCursor (db, indexName, range) {
  const p = Promise.withResolvers()
  await run('openCursor', [range, 'prev'], EVENTS_STORE, indexName, { db, p })

  let cursor
  while ((cursor = (await p.promise).result)) {
    yield cursor.value
    Object.assign(p, Promise.withResolvers())
    cursor.continue()
  }
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
        this.neverMatch = true
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
  return `c:${bytesToBase64(sha256(textEncoder.encode(`${kind}:${pubkey}:${dtag}`)))}`
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

async function applyDeletionRequest (db, tx, request, requestRef) {
  for (const tag of request.tags) {
    if (tag[0] === 'e') {
      await deleteEventTagTarget(db, tx, request, requestRef, tag[1])
    } else if (tag[0] === 'a') {
      await deleteAddressTagTarget(db, tx, request, requestRef, tag[1])
    }
  }
}

async function deleteEventTagTarget (db, tx, request, requestRef, id) {
  if (!HEX64_RE.test(id)) return

  const target = await run('get', [eventIdIndexKey(id)], EVENTS_STORE, INDEX.id, { db, tx })
    .then(v => v.result)

  await deleteMatchingTarget(db, tx, request, requestRef, target)
}

async function deleteAddressTagTarget (db, tx, request, requestRef, address) {
  const parsed = parseAddress(address)
  if (!parsed || parsed.pubkey !== request.pubkey) return

  const target = await run(
    'get',
    [coordinateRef(parsed.kind, parsed.pubkey, parsed.dtag)],
    EVENTS_STORE,
    null,
    { db, tx }
  ).then(v => v.result)

  await deleteMatchingTarget(db, tx, request, requestRef, target, {
    upToCreatedAt: request.created_at
  })
}

async function deleteMatchingTarget (db, tx, request, requestRef, target, { upToCreatedAt = Infinity } = {}) {
  if (!target || target.ref === requestRef) return
  if (target.event.pubkey !== request.pubkey) return
  if (target.event.created_at > upToCreatedAt) return

  await run('delete', [target.ref], EVENTS_STORE, null, { db, tx })
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
