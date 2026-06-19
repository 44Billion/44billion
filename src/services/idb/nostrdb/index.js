import { sha256 } from '@noble/hashes/sha2.js'

import { base16ToBase64, base64ToBase16, bytesToBase64 } from '#helpers/base64.js'
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

events, keyPath "i"
  i     base64url event id bytes, primary key
  a     optional address key: [kind, pubkeyKey, dTagKey]
  p     base64url pubkey bytes
  k     event kind
  ca    created_at timestamp
  ex    optional NIP-40 expiration timestamp
  t     multiEntry tag index keys: [tagName, sha256(tagValue), created_at]
  event original Nostr event

events indexes
  byAddress   a, unique, sparse
  byCreatedAt ca
  byExpiration ex
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
  address: 'byAddress',
  createdAt: 'byCreatedAt',
  expiration: 'byExpiration',
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
const HONORARY_EXPIRATION_SKEW = 60
const textEncoder = new TextEncoder()
const dbCache = new Map()
const storeCache = new Map()

const ADD_FAILURE_CODES = new Set(['invalid', 'expired', 'blocked', 'unavailable', 'error'])
const ADD_MESSAGES = {
  stored: 'Event was stored.',
  replaced: 'Event replaced an older stored coordinate event.',
  duplicate: 'Event is already stored.',
  superseded: 'A newer or tie-winning coordinate event is already stored.',
  published: 'Event was published to subscribers without being stored.',
  invalid: 'Event shape is invalid.',
  expired: 'Event is expired.',
  blocked: 'Event is blocked by a deletion request.',
  unavailable: 'IndexedDB is unavailable.',
  error: 'IndexedDB transaction failed.'
}

// add() only reports ok: false for invalid, expired, tombstone-blocked,
// unavailable, or transaction/write-error cases.
function addResult (code, { stored = false, published = false, message = ADD_MESSAGES[code] } = {}) {
  return {
    ok: !ADD_FAILURE_CODES.has(code),
    code,
    message,
    stored,
    published
  }
}

function publishResult (result) {
  return { ...result, published: true }
}

function logNostrDbIssue (method, details, error) {
  const level = details.code === 'unavailable' || details.code === 'error' || error
    ? 'error'
    : 'warn'
  const logger = console[level]
  if (typeof logger !== 'function') return

  if (error) {
    logger.call(console, '[nostrdb]', { method, ...details }, error)
  } else {
    logger.call(console, '[nostrdb]', { method, ...details })
  }
}

function eventLogSummary (event) {
  if (!event || typeof event !== 'object') return null

  const summary = {}
  if (typeof event.id === 'string') summary.id = event.id
  if (typeof event.pubkey === 'string') summary.pubkey = event.pubkey
  if (Number.isInteger(event.kind)) summary.kind = event.kind
  if (Number.isInteger(event.created_at)) summary.created_at = event.created_at

  return Object.keys(summary).length > 0 ? summary : null
}

export function getNostrDb (ownerPubkey) {
  if (!storeCache.has(ownerPubkey)) {
    storeCache.set(ownerPubkey, new NostrDb(ownerPubkey))
  }
  return storeCache.get(ownerPubkey)
}

/*
Usage:

  const db = getNostrDb(ownerPubkey)

  await db.add(event)
  const events = await db.query({ authors: [pubkey], kinds: [1], limit: 20 })
  const ids = await db.query({ since, until }, { ids_only: true })
  const total = await db.count([{ kinds: [1] }, { kinds: [30023] }])

  const sub = db.subscribe({ '#t': ['nostr'], search: 'relay' })
  for await (const event of sub) {
    // receives future matching events added through this module or another tab
  }

Filters follow NIP-01 shape plus local extensions: search, ids_only, !ids,
&<tag> AND filters, and top-level filter arrays as OR clauses.
*/
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

  // Public ingest path: valid transient events reach live subscribers, while
  // durable events are persisted through addEvent() before being published.
  async add (event) {
    if (!isValidEventShape(event)) {
      return this.reportAddResult('add', event, addResult('invalid'))
    }

    const now = currentUnixTime()

    if (isExpiredForIngest(event, now)) {
      return this.reportAddResult('add', event, addResult('expired'))
    }

    if (isNonDurableEvent(event)) {
      this.publish(event, true)
      return addResult('published', { published: true })
    }

    const result = await this.addEvent(event, { now, log: false })
    if (result.stored) {
      this.publish(event, true)
      return publishResult(result)
    }
    return this.reportAddResult('add', event, result)
  }

  // Durable write path used internally by add() and compaction; it updates
  // IndexedDB/tombstones but does not publish events by itself.
  async addEvent (event, { consumeDeletionRequestIds = [], now = currentUnixTime(), log = true } = {}) {
    if (!isValidEventShape(event)) {
      return this.reportAddResult('addEvent', event, addResult('invalid'), { log })
    }

    if (isExpiredForIngest(event, now)) {
      return this.reportAddResult('addEvent', event, addResult('expired'), { log })
    }
    if (isNonDurableEvent(event)) {
      return addResult('published', {
        message: 'Event is valid but non-durable; addEvent() does not store or publish it.'
      })
    }

    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return this.reportAddResult('addEvent', event, addResult('unavailable'), { log })

    const record = toStoredRecord(event, { now })
    let replaced = false

    try {
      const tx = db.transaction([EVENTS_STORE, DELETIONS_STORE], 'readwrite')
      const done = txDone(tx)

      const existingById = await run('get', [record.i], EVENTS_STORE, null, { db, tx })
        .then(v => v.result)

      if (existingById) {
        await done
        return addResult('duplicate')
      }

      if (await isBlockedByDeletion(db, tx, event)) {
        await done
        return this.reportAddResult('addEvent', event, addResult('blocked'), { log })
      }

      if (record.a) {
        const existingByAddress = await run('get', [record.a], EVENTS_STORE, INDEX.address, { db, tx })
          .then(v => v.result)

        if (existingByAddress && !isNewer(event, existingByAddress.event)) {
          await done
          return addResult('superseded')
        }

        if (existingByAddress) {
          await deleteStoredEvent(db, tx, existingByAddress)
          replaced = true
        }
      }

      if (event.kind === 5) {
        // Keep this chain IDB-only; unrelated awaits can let the transaction auto-commit.
        await applyDeletionRequest(db, tx, event)
      }

      for (const id of consumeDeletionRequestIds) {
        await deleteStoredDeletionRequestById(db, tx, id, event.pubkey)
      }

      await run('put', [record], EVENTS_STORE, null, { db, tx })
      await done
    } catch {
      return this.reportAddResult('addEvent', event, addResult('error'), { log })
    }

    return addResult(replaced ? 'replaced' : 'stored', { stored: true })
  }

  reportAddResult (method, event, result, { log = true } = {}) {
    if (log && !result.ok) {
      logNostrDbIssue(method, {
        ownerPubkey: this.ownerPubkey,
        code: result.code,
        message: result.message,
        event: eventLogSummary(event)
      })
    }
    return result
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
    if (!saved.stored) return compactResult()

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

  async purgeExpired ({ now } = {}) {
    const cutoff = normalizeTimestamp(now, currentUnixTime())
    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return 0

    try {
      const expiredIdKeys = await getExpiredIdKeys(db, cutoff)
      let removed = 0

      if (expiredIdKeys.length === 0) return 0

      const tx = db.transaction([EVENTS_STORE, DELETIONS_STORE], 'readwrite')
      const done = txDone(tx)

      for (const idKey of expiredIdKeys) {
        const stored = await run('get', [idKey], EVENTS_STORE, null, { db, tx })
          .then(v => v.result)
        if (!stored || isStoredRecordLive(stored, cutoff)) continue

        await deleteStoredEvent(db, tx, stored)
        removed++
      }

      await done
      return removed
    } catch {
      return 0
    }
  }

  startExpirationPurge ({
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
        await this.purgeExpired(options)
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

  async query (filterOrFilters, options = {}) {
    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return []

    try {
      const filters = parseFilterInput(filterOrFilters, options)
      return await queryParsedFilters(db, filters, { countOnly: false, ignoreLimit: false })
    } catch (error) {
      logNostrDbIssue('query', { ownerPubkey: this.ownerPubkey }, error)
      return []
    }
  }

  async count (filterOrFilters, options = {}) {
    const db = await openNostrDb(this.ownerPubkey)
    if (!db) return 0

    try {
      const filters = parseFilterInput(filterOrFilters, options)
      return await queryParsedFilters(db, filters, { countOnly: true, ignoreLimit: false })
    } catch (error) {
      logNostrDbIssue('count', { ownerPubkey: this.ownerPubkey }, error)
      return 0
    }
  }

  async supports () {
    return [
      'search',
      'search:sort:old',
      'search:autocomplete:true',
      'ids_only',
      '!ids',
      '&tags',
      'multi_filters'
    ]
  }

  async deleteDb () {
    this.bc?.close()
    this.bc = null
    return deleteNostrDb(this.ownerPubkey)
  }

  subscribe (filterOrFilters, options = {}) {
    const filters = parseFilterInput(filterOrFilters, options)
    const subscription = createSubscription(filters, {
      idsOnly: filters[0]?.idsOnly === true,
      limit: filters[0]?.limit ?? Infinity
    })
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

    store = createObjectStoreIfMissing(db, tx, EVENTS_STORE, { keyPath: 'i' })
    createIndexIfMissing(store, INDEX.address, 'a', { unique: true })
    createIndexIfMissing(store, INDEX.createdAt, 'ca')
    createIndexIfMissing(store, INDEX.expiration, 'ex')
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
const KEY_GATED_EXCLUDE_THRESHOLD = 128
const KEY_GATED_GET_BATCH_SIZE = 64

function parseFilterInput (filterOrFilters, options = {}) {
  const rawFilters = normalizeFilterList(filterOrFilters)
  if (rawFilters.length === 0) return []

  const controls = resolveFilterControls(rawFilters, normalizeOptions(options), {
    multi: Array.isArray(filterOrFilters)
  })

  return rawFilters.map(filter => new ParsedFilter(filter, controls))
}

function normalizeFilterList (filterOrFilters) {
  return Array.isArray(filterOrFilters) ? filterOrFilters : [filterOrFilters]
}

function normalizeOptions (options) {
  return options && typeof options === 'object' && !Array.isArray(options) ? options : {}
}

function resolveFilterControls (rawFilters, options, { multi }) {
  const first = rawFilters[0] && typeof rawFilters[0] === 'object' && !Array.isArray(rawFilters[0])
    ? rawFilters[0]
    : {}
  const controls = { ignoreFields: new Set() }
  const optionLimit = normalizeOptionalLimit(options.limit)

  if (multi || optionLimit !== undefined) {
    controls.hasLimit = true
    controls.limit = optionLimit ?? normalizeLimit(first.limit)
    controls.ignoreFields.add('limit')
  }

  if (multi || typeof options.ids_only === 'boolean') {
    controls.hasIdsOnly = true
    controls.idsOnly = typeof options.ids_only === 'boolean' ? options.ids_only : first.ids_only === true
    controls.ignoreFields.add('ids_only')
  }

  if (multi || typeof options.search === 'string') {
    controls.hasSearch = true
    controls.search = typeof options.search === 'string' ? options.search : first.search
    controls.ignoreFields.add('search')
  }

  return controls
}

function normalizeOptionalLimit (value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

async function queryRecords (db, rawFilter, { countOnly, ignoreLimit }) {
  return queryParsedFilters(db, parseFilterInput(rawFilter), { countOnly, ignoreLimit })
}

async function queryParsedFilters (db, filters, { countOnly, ignoreLimit }) {
  const liveFilters = filters.filter(filter => !filter.neverMatch)
  if (liveFilters.length === 0) return countOnly ? 0 : []
  if (liveFilters.length === 1) return queryParsedFilterRecords(db, liveFilters[0], { countOnly, ignoreLimit })

  return queryMultipleParsedFilters(db, liveFilters, { countOnly, ignoreLimit })
}

async function queryParsedFilterRecords (db, filter, { countOnly, ignoreLimit }) {
  if (filter.neverMatch) return countOnly ? 0 : []

  const limit = ignoreLimit ? Infinity : Math.min(countOnly ? Infinity : MAX_LIMIT, filter.limit)
  if (limit <= 0) return countOnly ? 0 : []

  const plan = planQuery(filter)
  const direction = filter.sortOld ? 'next' : 'prev'
  const now = currentUnixTime()

  if (filter.searchText) {
    const candidates = await collectSearchCandidates(db, plan, filter, direction, { countOnly, limit, now })

    if (countOnly) return Number.isFinite(limit) ? Math.min(candidates.length, limit) : candidates.length

    const ranked = rankSearchCandidates(candidates, filter, compareSearchTime)
    const results = ranked
      .slice(0, Number.isFinite(limit) ? limit : ranked.length)
      .map(candidate => candidate.event)
    return projectQueryResults(results, filter)
  }

  if (!countOnly && canUseKeyOnlyCursor(plan, filter)) {
    if (filter.idsOnly) {
      return queryIdsWithKeyCursor(db, plan, filter, direction, { limit, now })
    }

    // Key-gated fetching pays off during local DB sync when the other device
    // instance already has many IDs:
    // below this rough cutoff, one value cursor is usually cheaper than key cursor + per-row gets.
    if (filter.excludeIdKeySet?.size >= KEY_GATED_EXCLUDE_THRESHOLD) {
      return queryFullEventsWithKeyGate(db, plan, filter, direction, { limit, now })
    }
  }

  const seen = new Set()
  const results = []
  let count = 0

  const matches = stored => stored && isStoredRecordLive(stored, now) && filter.matches(stored.event)
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

      await scanCursor(db, EVENTS_STORE, cursor.indexName, cursor.range, {
        direction,
        onItem: stored => {
          if (!matches(stored)) return true
          matchedInCursor++
          emit(stored)
          if (countOnly && count >= limit) return false
          if (!countOnly && matchedInCursor >= limit) return false
          return true
        }
      })
      if (countOnly && count >= limit) break
    }
  }

  if (countOnly) return count

  results.sort(filter.sortOld ? compareOldest : compareNewest)
  return projectQueryResults(Number.isFinite(limit) ? results.slice(0, limit) : results, filter)
}

async function queryMultipleParsedFilters (db, filters, { countOnly, ignoreLimit }) {
  const limit = ignoreLimit ? Infinity : Math.min(countOnly ? Infinity : MAX_LIMIT, filters[0].limit)
  if (limit <= 0) return countOnly ? 0 : []

  if (filters[0].searchText) {
    return queryMultipleSearchFilters(db, filters, { countOnly, limit })
  }

  if (!countOnly && filters[0].idsOnly && filters.every(filter => canUseKeyOnlyCursor(planQuery(filter), filter))) {
    return queryMultipleIdsWithKeyCursor(db, filters, { limit })
  }

  const now = currentUnixTime()
  const seen = new Set()
  const results = []
  const compare = filters[0].sortOld ? compareOldest : compareNewest

  const emit = event => {
    if (seen.has(event.id)) return true

    seen.add(event.id)
    if (countOnly) return !Number.isFinite(limit) || seen.size < limit

    results.push(event)
    if (Number.isFinite(limit) && results.length > limit) {
      results.sort(compare)
      results.length = limit
    }
    return true
  }

  for (const filter of filters) {
    const keepGoing = await scanParsedFilterEvents(db, filter, { now, limit, countOnly, onEvent: emit })
    if (!keepGoing || (countOnly && seen.size >= limit)) break
  }

  if (countOnly) return Number.isFinite(limit) ? Math.min(seen.size, limit) : seen.size

  results.sort(compare)
  return projectQueryResults(Number.isFinite(limit) ? results.slice(0, limit) : results, filters[0])
}

async function queryMultipleIdsWithKeyCursor (db, filters, { limit }) {
  const now = currentUnixTime()
  const seen = new Set()
  const results = []
  const compare = filters[0].sortOld ? compareOldest : compareNewest

  for (const filter of filters) {
    const plan = planQuery(filter)
    const direction = filter.sortOld ? 'next' : 'prev'
    const candidates = await collectKeyGateCandidates(db, plan, filter, direction, { limit, now })

    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue

      seen.add(candidate.id)
      results.push(candidate)
      if (Number.isFinite(limit) && results.length > limit) {
        results.sort(compare)
        results.length = limit
      }
    }
  }

  results.sort(compare)
  return (Number.isFinite(limit) ? results.slice(0, limit) : results).map(result => result.id)
}

async function queryMultipleSearchFilters (db, filters, { countOnly, limit }) {
  const now = currentUnixTime()
  const candidatesById = new Map()

  for (const filter of filters) {
    const plan = planQuery(filter)
    const direction = filter.sortOld ? 'next' : 'prev'
    const candidates = await collectSearchCandidates(db, plan, filter, direction, { countOnly, limit, now })

    for (const candidate of candidates) {
      if (!candidatesById.has(candidate.event.id)) candidatesById.set(candidate.event.id, candidate)
      if (countOnly && Number.isFinite(limit) && candidatesById.size >= limit) {
        return limit
      }
    }
  }

  if (countOnly) return Number.isFinite(limit) ? Math.min(candidatesById.size, limit) : candidatesById.size

  const ranked = rankSearchCandidates([...candidatesById.values()], filters[0], compareSearchTime)
  const events = ranked
    .slice(0, Number.isFinite(limit) ? limit : ranked.length)
    .map(candidate => candidate.event)
  return projectQueryResults(events, filters[0])
}

async function scanParsedFilterEvents (db, filter, { now, limit, countOnly, onEvent }) {
  const plan = planQuery(filter)
  const direction = filter.sortOld ? 'next' : 'prev'
  const seen = new Set()

  const emit = stored => {
    if (!stored || !isStoredRecordLive(stored, now) || !filter.matches(stored.event)) return true
    if (seen.has(stored.event.id)) return true

    seen.add(stored.event.id)
    return onEvent(stored.event) !== false
  }

  if (filter.searchText) {
    const candidates = await collectSearchCandidates(db, plan, filter, direction, { countOnly, limit, now })
    const events = countOnly
      ? candidates.map(candidate => candidate.event)
      : rankSearchCandidates(candidates, filter, compareSearchTime).map(candidate => candidate.event)

    for (const event of events) {
      if (seen.has(event.id)) continue
      seen.add(event.id)
      if (onEvent(event) === false) return false
    }
    return true
  }

  if (plan.type === 'direct') {
    for (const cursor of plan.cursors) {
      const stored = await run('get', [cursor.key], EVENTS_STORE, cursor.indexName, { db })
        .then(v => v.result)
      if (emit(stored) === false) return false
    }
    return true
  }

  for (const cursor of plan.cursors) {
    let stopped = false

    await scanCursor(db, EVENTS_STORE, cursor.indexName, cursor.range, {
      direction,
      onItem: stored => {
        if (emit(stored) === false) {
          stopped = true
          return false
        }
        return true
      }
    })

    if (stopped) return false
  }

  return true
}

function projectQueryResults (events, filter) {
  return filter.idsOnly ? events.map(event => event.id) : events
}

async function queryIdsWithKeyCursor (db, plan, filter, direction, { limit, now }) {
  const expiredIdKeySet = await getExpiredIdKeySet(db, now)
  const seen = new Set()
  const results = []

  for (const cursor of plan.cursors) {
    let matchedInCursor = 0

    await scanKeyCursor(db, EVENTS_STORE, cursor.indexName, cursor.range, {
      direction,
      onItem: item => {
        const idKey = item.primaryKey
        if (seen.has(idKey)) return true
        if (filter.excludeIdKeySet?.has(idKey)) return true
        if (expiredIdKeySet.has(idKey)) return true

        seen.add(idKey)
        matchedInCursor++
        results.push({
          id: idKeyToEventId(idKey),
          created_at: timestampFromIndexKey(item.key, cursor.indexName)
        })

        return matchedInCursor < limit
      }
    })
  }

  results.sort(filter.sortOld ? compareOldest : compareNewest)
  return (Number.isFinite(limit) ? results.slice(0, limit) : results).map(result => result.id)
}

// Unlike the normal value cursor, this scans index keys first and fetches full
// rows only for IDs that are not already known by the other local DB instance.
async function queryFullEventsWithKeyGate (db, plan, filter, direction, { limit, now }) {
  const candidates = await collectKeyGateCandidates(db, plan, filter, direction, { limit, now })
  const results = []
  const matches = stored => stored && isStoredRecordLive(stored, now) && filter.matches(stored.event)

  for (let i = 0; i < candidates.length; i += KEY_GATED_GET_BATCH_SIZE) {
    const batch = candidates.slice(i, i + KEY_GATED_GET_BATCH_SIZE)
    const records = await getStoredRecordsByIdKeys(db, batch.map(candidate => candidate.idKey))

    for (const candidate of batch) {
      const stored = records.get(candidate.idKey)
      if (!matches(stored)) continue

      results.push(stored.event)
    }
  }

  results.sort(filter.sortOld ? compareOldest : compareNewest)
  return Number.isFinite(limit) ? results.slice(0, limit) : results
}

async function collectKeyGateCandidates (db, plan, filter, direction, { limit, now }) {
  const expiredIdKeySet = await getExpiredIdKeySet(db, now)
  const seen = new Set()
  const candidates = []

  for (const cursor of plan.cursors) {
    let matchedInCursor = 0

    await scanKeyCursor(db, EVENTS_STORE, cursor.indexName, cursor.range, {
      direction,
      onItem: item => {
        const idKey = item.primaryKey
        if (seen.has(idKey)) return true
        if (filter.excludeIdKeySet?.has(idKey)) return true
        if (expiredIdKeySet.has(idKey)) return true

        seen.add(idKey)
        matchedInCursor++
        candidates.push({
          id: idKeyToEventId(idKey),
          idKey,
          created_at: timestampFromIndexKey(item.key, cursor.indexName)
        })

        return matchedInCursor < limit
      }
    })
  }

  candidates.sort(filter.sortOld ? compareOldest : compareNewest)
  return Number.isFinite(limit) ? candidates.slice(0, limit) : candidates
}

async function getStoredRecordsByIdKeys (db, idKeys) {
  const tx = db.transaction([EVENTS_STORE], 'readonly')
  const store = tx.objectStore(EVENTS_STORE)
  const records = new Map()

  // Queue the whole batch synchronously so one readonly transaction owns all gets.
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(records)
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'))
    tx.onerror = () => reject(tx.error || new Error('transaction failed'))

    for (const idKey of idKeys) {
      const req = store.get(idKey)
      req.onsuccess = () => {
        if (req.result) records.set(idKey, req.result)
      }
      req.onerror = () => {
        reject(req.error)
        tx.abort()
      }
    }
  })
}

function scanCursor (db, storeName, indexName, range, { tx, direction = 'next', onItem }) {
  return scanIdbCursor(db, storeName, indexName, range, { tx, direction, onItem, keyOnly: false })
}

function scanKeyCursor (db, storeName, indexName, range, { tx, direction = 'next', onItem }) {
  return scanIdbCursor(db, storeName, indexName, range, { tx, direction, onItem, keyOnly: true })
}

// Keep cursor continuation inside the IDB success callback. Yielding a live
// cursor across unrelated awaits can let the transaction auto-commit first.
function scanIdbCursor (db, storeName, indexName, range, { tx, direction, onItem, keyOnly }) {
  return new Promise((resolve, reject) => {
    let storeOrIndex

    try {
      tx ??= db.transaction([storeName], 'readonly')
      const store = tx.objectStore(storeName)
      storeOrIndex = indexName ? store.index(indexName) : store
      const req = storeOrIndex[keyOnly ? 'openKeyCursor' : 'openCursor'](range, direction)

      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) {
          resolve()
          return
        }

        try {
          const item = keyOnly
            ? { key: cursor.key, primaryKey: cursor.primaryKey }
            : cursor.value
          if (onItem(item) === false) {
            resolve()
            return
          }
        } catch (error) {
          reject(error)
          tx.abort()
          return
        }

        cursor.continue()
      }
      req.onerror = () => {
        reject(req.error)
        tx.abort()
      }
    } catch (error) {
      reject(error)
    }
  })
}

async function getExpiredIdKeySet (db, now) {
  return new Set(await getExpiredIdKeys(db, now))
}

async function getExpiredIdKeys (db, now) {
  const expired = []
  const range = IDBKeyRange.upperBound(now)

  await scanKeyCursor(db, EVENTS_STORE, INDEX.expiration, range, {
    onItem: ({ primaryKey }) => {
      expired.push(primaryKey)
      return true
    }
  })

  return expired
}

function canUseKeyOnlyCursor (plan, filter) {
  // Covers sync inventory queries like:
  //   local DB A: query({ since, until, ids_only: true })
  //   local DB B: query({ since, until, "!ids": localDbAIds })
  // Also covers author/kind variants such as:
  //   query({ authors: [pubkey], kinds: [1], ids_only: true })
  // Search and mixed post-filter cases still need full event rows, so they stay on value cursors.
  if (filter.searchText || plan.type !== 'cursor') return false
  if (filter.andTags.length > 0) return false
  if (plan.cursors.length === 0) return false

  return plan.cursors.every(cursor => {
    if (cursor.indexName === INDEX.createdAt) return true
    if (cursor.indexName === INDEX.pubkey) return true
    if (cursor.indexName === INDEX.kind) return true
    if (cursor.indexName === INDEX.pubkeyKind) return true
    return (
      cursor.indexName === INDEX.tag &&
      filter.tags.length === 1 &&
      filter.tags[0].name.length === 1 &&
      !filter.authors &&
      !filter.kinds
    )
  })
}

function timestampFromIndexKey (key, indexName) {
  if (indexName === INDEX.createdAt) return key
  if (indexName === INDEX.pubkey || indexName === INDEX.kind) return key[1]
  if (indexName === INDEX.pubkeyKind || indexName === INDEX.tag) return key[2]
  return 0
}

// IDB scanning stays here because it knows about plans, stores, cursors, and caps.
async function collectSearchCandidates (db, plan, filter, direction, { countOnly, limit, now }) {
  const matches = []
  const seen = new Set()
  const matchTarget = searchMatchTarget(countOnly, limit)

  const toCandidate = stored => {
    if (
      !stored ||
      !isStoredRecordLive(stored, now) ||
      seen.has(stored.event.id) ||
      !filter.matchesStructured(stored.event)
    ) return null
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

  let scanned = 0
  let batchCount = 0
  let batchScanned = 0
  let batchCandidates = []
  let stop = false

  const flushBatch = () => {
    if (batchScanned === 0) return
    matches.push(...matchSearchCandidates(batchCandidates, filter))
    batchCandidates = []
    batchScanned = 0
    batchCount++
    stop = shouldStopSearch(countOnly, batchCount, matches.length, matchTarget)
  }

  for (const cursor of plan.cursors) {
    await scanCursor(db, EVENTS_STORE, cursor.indexName, cursor.range, {
      direction,
      onItem: stored => {
        if (stop || scanned >= SEARCH_MAX_CANDIDATES || batchCount >= SEARCH_MAX_BATCHES) return false

        scanned++
        batchScanned++
        const candidate = toCandidate(stored)
        if (candidate) batchCandidates.push(candidate)

        if (batchScanned >= SEARCH_BATCH_SIZE || scanned >= SEARCH_MAX_CANDIDATES) flushBatch()
        return !stop && scanned < SEARCH_MAX_CANDIDATES && batchCount < SEARCH_MAX_BATCHES
      }
    })

    flushBatch()
    if (stop || scanned >= SEARCH_MAX_CANDIDATES || batchCount >= SEARCH_MAX_BATCHES) break
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
      cursors: filter.ids.map(id => ({ key: eventIdIndexKey(id) }))
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

  if (filter.tags.length > 0 || filter.andTags.length > 0) {
    const tag = [...filter.tags, ...filter.andTags]
      .reduce((a, b) => (b.values.length < a.values.length ? b : a))
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
        cursors.push({ indexName: INDEX.address, key: addressKey(kind, author, dtag) })
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
      cursors.push({ indexName: INDEX.address, key: addressKey(kind, author, '') })
    }
  }
  return cursors
}

function createSubscription (filters, { idsOnly = false, limit = Infinity } = {}) {
  const queue = []
  const waiters = []
  let closed = false
  let yielded = 0
  let onClose

  const close = () => {
    if (closed) return
    closed = true
    onClose?.()
    while (waiters.length > 0) {
      waiters.shift().resolve({ done: true })
    }
  }

  const subscription = {
    push (event) {
      if (closed || !filters.some(filter => filter.matches(event))) return
      const value = idsOnly ? event.id : event
      yielded++
      if (waiters.length > 0) {
        waiters.shift().resolve({ value, done: false })
      } else {
        queue.push(value)
      }
      if (yielded >= limit) close()
    },
    iterator (closeSubscription) {
      onClose = closeSubscription
      if (limit <= 0 || filters.length === 0) close()
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
          close()
          return Promise.resolve({ done: true })
        }
      }
    }
  }
  return subscription
}

export class ParsedFilter {
  constructor (filter, controls = {}) {
    this.ids = undefined
    this.authors = undefined
    this.kinds = undefined
    this.dtags = undefined
    this.excludeIds = undefined
    this.excludeIdSet = undefined
    this.excludeIdKeySet = undefined
    this.tags = []
    this.andTags = []
    this.since = 0
    this.until = Infinity
    this.limit = Infinity
    this.idsOnly = false
    this.neverMatch = false
    this.sortOld = false
    this.autocomplete = false
    this.searchText = ''

    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      this.neverMatch = true
      return
    }

    for (const [key, value] of Object.entries(filter)) {
      if (controls.ignoreFields?.has(key)) continue
      if ((key.startsWith('#') || key.startsWith('&')) && key.length !== 2) continue

      if (Array.isArray(value) && value.length === 0 && key !== '!ids') {
        this.neverMatch = true
        continue
      }

      if (key === 'ids') {
        this.ids = normalizeStringArray(value, HEX64_RE)
      } else if (key === '!ids') {
        const excludeIds = normalizeStringArray(value, HEX64_RE)
        if (excludeIds.length > 0) {
          this.excludeIds = excludeIds
          this.excludeIdSet = new Set(excludeIds)
          this.excludeIdKeySet = new Set(excludeIds.map(eventIdIndexKey))
        }
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
      } else if (key === 'ids_only') {
        this.idsOnly = value === true
      } else if (key === 'search') {
        const search = parseSearch(value)
        this.sortOld = search.sortOld
        this.autocomplete = search.autocomplete
        this.searchText = search.text
      } else if (key.startsWith('#')) {
        const values = normalizeTagValues(value)
        const tag = { name: key.slice(1), values }
        this.tags.push(tag)
        if (key === '#d') this.dtags = values
      } else if (key.startsWith('&')) {
        this.andTags.push({ name: key.slice(1), values: normalizeTagValues(value) })
      }
    }

    if (controls.hasLimit) this.limit = controls.limit
    if (controls.hasIdsOnly) this.idsOnly = controls.idsOnly
    if (controls.hasSearch) {
      const search = parseSearch(controls.search)
      this.sortOld = search.sortOld
      this.autocomplete = search.autocomplete
      this.searchText = search.text
    }

    this.tags = pruneOrTagsCoveredByAndTags(this.tags, this.andTags)
    this.dtags = this.tags.find(tag => tag.name === 'd')?.values

    if (this.ids && this.excludeIdSet) {
      this.ids = this.ids.filter(id => !this.excludeIdSet.has(id))
    }

    if (
      this.ids?.length === 0 ||
      this.authors?.length === 0 ||
      this.kinds?.length === 0 ||
      this.dtags?.length === 0 ||
      this.tags.some(tag => tag.values.length === 0) ||
      this.andTags.some(tag => tag.values.length === 0)
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
    if (this.excludeIdSet?.has(event.id)) return false
    if (this.authors && !this.authors.includes(event.pubkey)) return false
    if (this.kinds && !this.kinds.includes(event.kind)) return false

    for (const { name, values } of this.tags) {
      if (!event.tags.some(tag => tag[0] === name && values.includes(tag[1]))) return false
    }

    for (const { name, values } of this.andTags) {
      for (const value of values) {
        if (!event.tags.some(tag => tag[0] === name && tag[1] === value)) return false
      }
    }

    return true
  }
}

export function toStoredRecord (event, { now = currentUnixTime() } = {}) {
  const coordinate = getCoordinate(event)
  const record = {
    i: eventIdIndexKey(event.id),
    p: pubkeyIndexKey(event.pubkey),
    k: event.kind,
    ca: event.created_at,
    t: tagIndexKeys(event),
    event
  }
  const expiration = getExpiration(event)

  if (coordinate !== null) record.a = addressKey(event.kind, event.pubkey, coordinate)
  if (expiration !== null && expiration > now) record.ex = expiration

  return record
}

export function getCoordinate (event) {
  if (isRegularReplaceableKind(event.kind)) return ''
  if (isAddressableKind(event.kind)) return getDTag(event) ?? ''
  return getDTag(event)
}

export function eventRef (id) {
  return eventIdIndexKey(id)
}

export function coordinateRef (kind, pubkey, dtag) {
  return addressKey(kind, pubkey, dtag)
}

export function addressKey (kind, pubkey, dtag) {
  return [kind, pubkeyIndexKey(pubkey), dtag === '' ? '' : tagValueIndexKey(dtag)]
}

export function deletionEventRef (id, pubkey) {
  return `e:${eventIdIndexKey(id)}:${pubkeyIndexKey(pubkey)}`
}

export function deletionCoordinateRef (kind, pubkey, dtag) {
  return `a:${kind}:${pubkeyIndexKey(pubkey)}:${dtag === '' ? '' : tagValueIndexKey(dtag)}`
}

export function eventIdIndexKey (id) {
  return base16ToBase64(id)
}

export function idKeyToEventId (idKey) {
  return base64ToBase16(idKey)
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

export function currentUnixTime () {
  return Math.floor(Date.now() / 1000)
}

export function getExpiration (event) {
  if (!Array.isArray(event?.tags)) return null

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag[0] !== 'expiration') continue

    const timestamp = parseExpirationTimestamp(tag[1])
    if (timestamp !== null) return timestamp
  }

  return null
}

export function isEphemeralKind (kind) {
  return kind >= 20000 && kind < 30000
}

export function isHonoraryEphemeralEvent (event) {
  const expiration = getExpiration(event)
  return expiration !== null && expiration === event.created_at
}

export function isExpiredEvent (event, now = currentUnixTime(), { honorarySkew = 0 } = {}) {
  const expiration = getExpiration(event)
  if (expiration === null) return false

  const expiresAt = isHonoraryEphemeralEvent(event)
    ? expiration + honorarySkew
    : expiration

  return expiresAt <= now
}

export function isExpiredForIngest (event, now = currentUnixTime()) {
  return isExpiredEvent(event, now, { honorarySkew: HONORARY_EXPIRATION_SKEW })
}

export function isNonDurableEvent (event) {
  return isEphemeralKind(event.kind) || isHonoraryEphemeralEvent(event)
}

export function shouldSkipStorage (event, now = currentUnixTime()) {
  return (
    isNonDurableEvent(event) ||
    isExpiredEvent(event, now)
  )
}

function isStoredRecordLive (stored, now) {
  return !!stored?.event && !shouldSkipStorage(stored.event, now)
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

function parseExpirationTimestamp (value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null

  const timestamp = Number(value)
  return Number.isInteger(timestamp) && timestamp >= 0 && timestamp <= 0xffffffff
    ? timestamp
    : null
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

async function applyDeletionRequest (db, tx, request) {
  for (const tag of request.tags) {
    const target = deletionTargetFromTag(request, tag)
    if (!target) continue

    await addDeletionContribution(db, tx, target, request)
    await deleteDeletionTarget(db, tx, request, target)
  }
}

function deletionTargetFromTag (request, tag) {
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

  const requestAddress = getCoordinate(request)
  if (
    requestAddress !== null &&
    compareKeys(addressKey(parsed.kind, parsed.pubkey, parsed.dtag), addressKey(request.kind, request.pubkey, requestAddress)) === 0
  ) return null

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

async function deleteDeletionTarget (db, tx, request, target) {
  let stored

  if (target.type === 'e') {
    stored = await run('get', [eventIdIndexKey(target.id)], EVENTS_STORE, null, { db, tx })
      .then(v => v.result)
  } else {
    stored = await run(
      'get',
      [addressKey(target.kind, target.pubkey, target.dtag)],
      EVENTS_STORE,
      INDEX.address,
      { db, tx }
    ).then(v => v.result)
  }

  await deleteMatchingTarget(db, tx, request, stored, {
    upToCreatedAt: target.upToCreatedAt
  })
}

async function deleteMatchingTarget (db, tx, request, target, { upToCreatedAt = Infinity } = {}) {
  if (!target || target.i === eventIdIndexKey(request.id)) return
  if (target.event.pubkey !== request.pubkey) return
  if (target.event.created_at > upToCreatedAt) return

  await deleteStoredEvent(db, tx, target)
}

async function deleteStoredDeletionRequestById (db, tx, id, author) {
  if (!HEX64_RE.test(id)) return false

  const target = await run('get', [eventIdIndexKey(id)], EVENTS_STORE, null, { db, tx })
    .then(v => v.result)

  if (!target || target.event.kind !== 5 || target.event.pubkey !== author) return false

  await deleteStoredEvent(db, tx, target)
  return true
}

async function deleteStoredEvent (db, tx, stored) {
  await run('delete', [stored.i], EVENTS_STORE, null, { db, tx })

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

  await scanCursor(db, DELETIONS_STORE, DELETION_INDEX.request, range, {
    tx,
    onItem: row => {
      rows.push(row)
      return true
    }
  })

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

function pruneOrTagsCoveredByAndTags (tags, andTags) {
  if (andTags.length === 0) return tags

  const andValuesByName = new Map()
  for (const tag of andTags) {
    const values = andValuesByName.get(tag.name) ?? new Set()
    for (const value of tag.values) values.add(value)
    andValuesByName.set(tag.name, values)
  }

  const pruned = []
  for (const tag of tags) {
    const andValues = andValuesByName.get(tag.name)
    if (!andValues) {
      pruned.push(tag)
      continue
    }

    const values = tag.values.filter(value => !andValues.has(value))
    if (values.length > 0) pruned.push({ ...tag, values })
  }

  return pruned
}

function normalizeTimestamp (value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function normalizeLimit (value) {
  return Number.isInteger(value) && value >= 0 ? value : Infinity
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
