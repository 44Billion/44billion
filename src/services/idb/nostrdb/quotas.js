import { createQuotaScheduler, quotaBlocks, quotaTotalKeys, readQuotaState, reloadQuotaState, publishQuotaState, resetQuotaStateMemory, reportQuotaStateFailure } from './quota-state.js'
export { readQuotaState, subscribeQuotaState, quotaNeedsAttention } from './quota-state.js'
import { recordPerformance } from '#services/performance-diagnostics.js'
import { assertNostrDbAccess, isNostrDbAccessError } from './access.js'
import {
  NOSTRDB_CACHE_ACCESS_STORE as CACHE,
  NOSTRDB_MAINTENANCE_STORE as MAINTENANCE,
  NOSTRDB_QUOTA_USAGE_KEY as USAGE_KEY,
  NOSTRDB_QUOTA_SETTINGS_KEY as SETTINGS_KEY,
  NOSTRDB_QUOTA_STATE_KEY as STATE_KEY
} from '#constants/storage-schema.js'
import { isPersonalCopyEvent } from '#helpers/personal-copy.js'
import {
  NOSTRDB_PREFIX, EVENTS_STORE, DELETIONS_STORE, INDEX,
  openNostrDb, captureNostrDbConnection, eventIdIndexKey, addressKey, getCoordinate, deleteStoredEvent
} from './index.js'

export const QUOTA_LOCK = '44billion:nostrdb-quota:v1'
export const CACHE_ACCESS_INDEX = 'byLastAccess'
export const DEFAULT_NOSTRDB_QUOTAS = Object.freeze({
  publicBytes: 512 * 1024 * 1024,
  privateBytes: 1024 * 1024 * 1024,
  cacheBytes: 128 * 1024 * 1024,
  cacheCount: 50000
})
const encoder = new TextEncoder()
const contexts = new WeakMap()
const touchQueue = new Map()
let touchTimer
let touchRunning = false
let maintenance
let channel
let reviewPromise

function broadcastQuotaMessage (message) {
  try { channel?.postMessage(message) } catch {
    // Cross-context hints must not turn a committed mutation into a failure.
    recordPerformance({ stage: 'quota-state-notify-failed' })
  }
}

export class NostrDbQuotaError extends Error {
  constructor (category) {
    super(`NostrDB ${category} quota exceeded`)
    this.code = 'quota'
    this.category = category
  }
}

function unavailable () {
  return Object.assign(new Error('NostrDB quota coordination is unavailable'), { code: 'unavailable' })
}

export function withNostrDbQuotaLock (callback, onTiming) {
  if (!globalThis.navigator?.locks?.request) return Promise.reject(unavailable())
  if (typeof IS_DEVELOPMENT === 'undefined' || !IS_DEVELOPMENT) return navigator.locks.request(QUOTA_LOCK, callback)
  const queuedAt = performance.now()
  return navigator.locks.request(QUOTA_LOCK, async () => {
    const startedAt = performance.now()
    const report = entry => { if (onTiming) { try { onTiming(entry) } catch {} } else recordPerformance(entry) }
    report({ stage: 'quota-lock-wait', elapsedMs: startedAt - queuedAt })
    try { return await callback() } finally { report({ stage: 'quota-lock-execution', elapsedMs: performance.now() - startedAt }) }
  })
}

export function cacheEventLimit (bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Invalid cache byte limit')
  return Number(BigInt(bytes) * 50000n / 134217728n)
}

export function getNostrDbQuotaLimits () {
  let overrides
  try { overrides = JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) ?? 'null') } catch {}
  const limits = { ...DEFAULT_NOSTRDB_QUOTAS }
  for (const key of ['publicBytes', 'privateBytes', 'cacheBytes']) {
    if (Number.isSafeInteger(overrides?.[key]) && overrides[key] >= 0) limits[key] = overrides[key]
  }
  limits.cacheCount = cacheEventLimit(limits.cacheBytes)
  return limits
}

// Launcher-only configuration: this is deliberately absent from the app bridge.
export async function setNostrDbQuotaLimits (overrides) {
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!['publicBytes', 'privateBytes', 'cacheBytes'].includes(key) || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Invalid NostrDB quota limit')
    }
  }
  const limits = await withNostrDbQuotaLock(() => {
    if (!globalThis.localStorage) throw unavailable()
    const next = { ...getNostrDbQuotaLimits(), ...overrides }
    delete next.cacheCount
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
    const limits = getNostrDbQuotaLimits()
    try { publishQuotaState({ limits }) } catch {
      reportQuotaStateFailure()
      recordPerformance({ stage: 'quota-state-persist-failed' })
    }
    broadcastQuotaMessage({ type: 'state' })
    return limits
  })
  scheduleQuotaMaintenance({ immediate: true })
  return limits
}

function request (req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function transactionDone (tx) {
  return new Promise((resolve, reject) => {
    tx.addEventListener('complete', resolve, { once: true })
    tx.addEventListener('abort', () => reject(tx.error || new Error('NostrDB transaction aborted')), { once: true })
  })
}

function emptyTotals () {
  return { publicBytes: 0, publicCount: 0, privateBytes: 0, privateCount: 0, cacheBytes: 0, cacheCount: 0 }
}

export function initialQuotaUsage (ready = false) {
  return { key: USAGE_KEY, version: 1, phase: ready ? 'ready' : 'records', after: null, ...emptyTotals() }
}

export function ownerReferenceKeys (event, owner) {
  if (event.pubkey !== owner) return []
  return referenceKeysFromTags(event.tags)
}

export function referenceKeysFromTags (tags) {
  const refs = new Set()
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (tag[0]?.length !== 1 || typeof tag[1] !== 'string') continue
    const value = tag[1]
    if (/^[0-9a-f]{64}$/i.test(value)) {
      refs.add(`e:${eventIdIndexKey(value.toLowerCase())}`)
      continue
    }
    const [kindText, pubkey, ...parts] = value.split(':')
    if (!/^\d+$/.test(kindText) || !/^[0-9a-f]{64}$/i.test(pubkey ?? '') || parts.length === 0) continue
    const kind = Number(kindText)
    if (!Number.isInteger(kind) || kind < 0 || kind > 65535) continue
    const d = kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000) ? '' : parts.join(':')
    refs.add(`a:${addressKey(kind, pubkey.toLowerCase(), d).join(':')}`)
  }
  return [...refs].sort()
}

function ownerFromDb (db) {
  return db.name.startsWith(NOSTRDB_PREFIX) ? db.name.slice(NOSTRDB_PREFIX.length) : null
}

function prepareRecord (db, row, { personalCopyRefs } = {}) {
  const owner = ownerFromDb(db)
  row.eventBytes = encoder.encode(JSON.stringify(row.event)).byteLength
  if (isOwnerPersonalCopy(db, row)) {
    if (Array.isArray(personalCopyRefs)) {
      row.ownerRefs = [...new Set(personalCopyRefs)].sort()
    } else if (!Array.isArray(row.ownerRefs)) {
      row.ownerRefs = []
    }
  } else {
    row.ownerRefs = ownerReferenceKeys(row.event, owner)
  }
  return row
}

function foreignPublic (db, row) {
  return row.event.pubkey !== ownerFromDb(db)
}

function isOwnerPersonalCopy (db, row) {
  return isPersonalCopyEvent(row.event) && row.event.pubkey === ownerFromDb(db)
}

function eventQuotaCategory (db, row) {
  return isOwnerPersonalCopy(db, row) ? 'private' : 'public'
}

export async function isOwnerReferenced (db, tx, row) {
  if (!foreignPublic(db, row)) return false
  const index = tx.objectStore(EVENTS_STORE).index(INDEX.ownerRef)
  if (await request(index.getKey(`e:${row.i}`)) !== undefined) return true
  const coordinate = getCoordinate(row.event)
  if (coordinate === null) return false
  const ref = `a:${addressKey(row.event.kind, row.event.pubkey, coordinate).join(':')}`
  return await request(index.getKey(ref)) !== undefined
}

function changeEventTotals (usage, row, sign, category) {
  usage[`${category}Bytes`] += sign * row.eventBytes
  usage[`${category}Count`] += sign
}

async function setCacheClassification (db, tx, row, usage, { initial = false } = {}) {
  const store = tx.objectStore(CACHE)
  const access = await request(store.get(row.i))
  const cached = foreignPublic(db, row) && !await isOwnerReferenced(db, tx, row)
  if (cached === !!access) return
  changeEventTotals(usage, row, cached ? -1 : 1, 'public')
  changeEventTotals(usage, row, cached ? 1 : -1, 'cache')
  if (cached) {
    await request(store.put({ i: row.i, lastAccessAt: initial && Number.isFinite(row.ra) ? row.ra : Date.now() }))
  } else {
    await request(store.delete(row.i))
  }
}

async function forPage (tx, after, visit) {
  const store = tx.objectStore(EVENTS_STORE)
  return new Promise((resolve, reject) => {
    let count = 0
    const req = store.openCursor(after === null ? null : IDBKeyRange.lowerBound(after, true))
    req.onerror = () => reject(req.error)
    req.onsuccess = async () => {
      const cursor = req.result
      if (!cursor) { resolve(null); return }
      try {
        // visit only awaits IDB requests, preserving the live transaction.
        await visit(cursor.value)
        if (++count >= 1000) resolve(cursor.primaryKey)
        else cursor.continue()
      } catch (error) { reject(error) }
    }
  })
}

async function initializeUsage (db) {
  const connection = captureNostrDbConnection(ownerFromDb(db))
  if (!connection || await connection.resolve() !== db) throw unavailable()
  const check = () => {
    if (!connection.isCurrent()) throw Object.assign(new Error('NOSTRDB_RESET'), { code: 'NOSTRDB_RESET' })
  }
  check()
  // Most databases are already initialized. This narrow readonly transaction
  // neither waits for nor blocks cacheAccess writes on the other store.
  const readyTx = db.transaction(MAINTENANCE)
  const readyDone = transactionDone(readyTx)
  try {
    const ready = await request(readyTx.objectStore(MAINTENANCE).get(USAGE_KEY))
    await readyDone
    if (ready?.phase === 'ready') return ready
  } catch (error) {
    await readyDone.catch(() => {})
    throw error
  }
  while (true) {
    check()
    const tx = db.transaction([EVENTS_STORE, CACHE, MAINTENANCE], 'readwrite')
    const done = transactionDone(tx)
    try {
      const stateStore = tx.objectStore(MAINTENANCE)
      const usage = await request(stateStore.get(USAGE_KEY)) ?? initialQuotaUsage()
      if (usage.phase === 'ready') { await done; return usage }
      const phase = usage.phase
      usage.after = await forPage(tx, usage.after, async row => {
        if (phase === 'records') {
          prepareRecord(db, row)
          await request(tx.objectStore(EVENTS_STORE).put(row))
        } else {
          changeEventTotals(usage, row, 1, eventQuotaCategory(db, row))
          await setCacheClassification(db, tx, row, usage, { initial: true })
        }
      })
      if (usage.after === null) usage.phase = phase === 'records' ? 'classify' : 'ready'
      await request(stateStore.put(usage))
      await done
      if (usage.phase === 'ready') return usage
    } catch (error) {
      try { tx.abort() } catch {}
      await done.catch(() => {})
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

async function allDatabases () {
  if (typeof globalThis.indexedDB?.databases !== 'function') throw unavailable()
  let databases
  try { databases = await indexedDB.databases() } catch { throw unavailable() }
  const names = databases.map(({ name }) => name)
    .filter(name => name?.startsWith(NOSTRDB_PREFIX)).sort()
  const dbs = []
  for (const name of names) {
    // An inaccessible bank may still occupy space during lifecycle cleanup.
    // Keep the last complete aggregate rather than publishing a partial sum.
    const db = await openNostrDb(name.slice(NOSTRDB_PREFIX.length), { quotaLockHeld: true, create: false })
    if (!db) throw unavailable()
    await initializeUsage(db)
    dbs.push(db)
  }
  return dbs
}

async function sumUsage (dbs) {
  const totals = emptyTotals()
  for (const db of dbs) {
    const usage = await request(db.transaction(MAINTENANCE).objectStore(MAINTENANCE).get(USAGE_KEY))
    if (usage?.phase !== 'ready') throw unavailable()
    for (const key of Object.keys(totals)) totals[key] += usage[key]
  }
  return totals
}

export function getNostrDbQuotaUsage () {
  return reviewQuotaUsage(false).then(result => result.totals)
}

// Explicit reads share an in-flight review. Cache eviction only belongs to
// maintenance; opening settings must not synchronously delete cached events.
function reviewQuotaUsage (cleanup, scheduled = false) {
  if (!cleanup && reviewPromise) return reviewPromise
  const work = (async () => {
    let waitedRevision
    while (true) {
      const result = await withNostrDbQuotaLock(async () => {
        const limits = getNostrDbQuotaLimits()
        const previous = reloadQuotaState()
        const startedAt = Date.now()
        if (previous && previous.revision !== waitedRevision && startedAt >= previous.maintenance.startedAt && startedAt < (previous.maintenance.retryAt ?? 0)) {
          return { deferMs: previous.maintenance.retryAt - startedAt, revision: previous.revision }
        }
        if (previous && previous.revision !== waitedRevision && startedAt >= previous.maintenance.startedAt && startedAt < previous.maintenance.startedAt + 250) {
          return { deferMs: previous.maintenance.startedAt + 250 - startedAt, revision: previous.revision }
        }
        let stats = { examined: 0, deleted: 0, exhausted: false }
        try {
          const dbs = await allDatabases()
          const totals = cleanup
            ? await evict(dbs, limits, { maxDeleted: 25, maxExamined: 100, onStats: value => { stats = value } })
            : await sumUsage(dbs)
          const excess = cacheExcess(totals, limits)
          publishQuotaState({
            totals, limits, checkedAt: Date.now(), maintenance: {
              startedAt,
              failed: false, failureCount: 0, retryAt: 0,
              cacheAttention: excess && (cleanup ? stats.exhausted : previous?.maintenance.cacheAttention ?? false)
            }
          })
          broadcastQuotaMessage({ type: 'state' })
          recordPerformance({ stage: 'quota-review', elapsedMs: Date.now() - startedAt, ...stats, excess })
          return { totals, excess }
        } catch (error) {
          try {
            const failureCount = Math.min(6, (previous?.maintenance.failureCount ?? 0) + 1)
            publishQuotaState({
              limits, maintenance: {
                startedAt,
                failed: true, failureCount, retryAt: Date.now() + Math.min(30000, 1000 * 2 ** (failureCount - 1)), cacheAttention: !!previous?.blocked.cache
              }
            })
            broadcastQuotaMessage({ type: 'state' })
          } catch {}
          recordPerformance({ stage: 'quota-review-failed', elapsedMs: Date.now() - startedAt })
          throw error
        }
      }, entry => recordPerformance({ ...entry, category: cleanup ? 'maintenance' : 'review' }))
      if (!result.deferMs || scheduled) return result
      // Wait outside the lock. The revision check also handles a wall clock
      // that stays fixed or moves backwards while this context is suspended.
      await new Promise(resolve => setTimeout(resolve, result.deferMs))
      waitedRevision = result.revision
    }
  })().catch(error => {
    reportQuotaStateFailure()
    scheduleQuotaMaintenance()
    recordPerformance({ stage: 'quota-review-unavailable' })
    throw error
  })
  if (cleanup) return work
  reviewPromise = work.finally(() => { reviewPromise = null })
  return reviewPromise
}

// Called from the common event deletion path, before its event row is removed.
export async function accountDeletedEvent (db, tx, row) {
  const ctx = contexts.get(tx)
  if (!ctx) throw new Error('Event deletion requires a quota transaction')
  const store = tx.objectStore(CACHE)
  const cached = await request(store.get(row.i))
  changeEventTotals(ctx.usage, row, -1, cached ? 'cache' : eventQuotaCategory(db, row))
  if (cached) {
    await request(store.delete(row.i))
  }
  for (const ref of row.ownerRefs ?? []) ctx.refs.add(ref)
}

export async function putQuotaEvent (db, tx, row, { personalCopy, personalCopyRefs } = {}) {
  const ctx = contexts.get(tx)
  if (!ctx) throw new Error('Event insertion requires a quota transaction')
  // The quota writer is the only internal storage path: a personal copy must
  // be owner-signed and carry the metadata produced by its validation.
  if (isPersonalCopyEvent(row.event)) {
    if (row.event.pubkey !== ownerFromDb(db)) throw new Error('Foreign personal copy')
    if (
      !personalCopy ||
      personalCopy.eventId !== row.event.id ||
      personalCopy.eventJson !== JSON.stringify(row.event)
    ) {
      throw new Error('Unvalidated personal copy')
    }
  }
  prepareRecord(db, row, { personalCopyRefs })
  await request(tx.objectStore(EVENTS_STORE).put(row))
  changeEventTotals(ctx.usage, row, 1, eventQuotaCategory(db, row))
  await setCacheClassification(db, tx, row, ctx.usage)
  for (const ref of row.ownerRefs) ctx.refs.add(ref)
}

async function reconcileChangedReferences (db, tx, ctx) {
  const store = tx.objectStore(EVENTS_STORE)
  const seen = new Set()
  for (const ref of ctx.refs) {
    if (!ref.startsWith('e:') && !ref.startsWith('a:')) continue
    let row
    if (ref.startsWith('e:')) row = await request(store.get(ref.slice(2)))
    else {
      const [, kind, pubkey, d] = ref.split(':')
      row = await request(store.index(INDEX.address).get([Number(kind), pubkey, d]))
    }
    if (!row || seen.has(row.i) || !foreignPublic(db, row)) continue
    seen.add(row.i)
    // Moving an already stored target between budgets is not new admission.
    // Protection must never discard a target to make room for its referrer.
    await setCacheClassification(db, tx, row, ctx.usage)
  }
}

async function mutate (db, callback, admission) {
  const connection = captureNostrDbConnection(ownerFromDb(db))
  if (!connection || await connection.resolve() !== db || !connection.isCurrent()) throw unavailable()
  const tx = db.transaction([EVENTS_STORE, DELETIONS_STORE, CACHE, MAINTENANCE], 'readwrite')
  const done = transactionDone(tx)
  try {
    const stateStore = tx.objectStore(MAINTENANCE)
    const usage = await request(stateStore.get(USAGE_KEY))
    if (usage?.phase !== 'ready') throw unavailable()
    if (!connection.isCurrent()) throw unavailable()
    const before = { ...usage }
    const ctx = { usage, refs: new Set() }
    contexts.set(tx, ctx)
    const result = await callback(tx)
    // Capture direct admission before reference-induced category transfers.
    const delta = Object.fromEntries(quotaTotalKeys.map(key => [key, usage[key] - before[key]]))
    await reconcileChangedReferences(db, tx, ctx)
    if (admission) {
      for (const category of ['public', 'private', 'cache']) {
        if (admission[category] && (delta[`${category}Bytes`] > 0 || (category === 'cache' && delta.cacheCount > 0))) {
          recordPerformance({ stage: 'quota-growth-blocked', category })
          throw new NostrDbQuotaError(category)
        }
      }
    }
    if (!connection.isCurrent()) throw unavailable()
    await request(stateStore.put(usage))
    await done
    const volume = quotaTotalKeys.filter(key => key.endsWith('Bytes')).reduce((sum, key) => sum + Math.abs(usage[key] - before[key]), 0)
    scheduleQuotaMaintenance({ count: 1, volume })
    return result
  } catch (error) {
    try { tx.abort() } catch {}
    await done.catch(() => {})
    throw error
  } finally {
    contexts.delete(tx)
  }
}

function cacheExcess (totals, limits) {
  return ['cacheBytes', 'cacheCount'].some(key => totals[key] > limits[key])
}

async function nextAccess (db, after) {
  const tx = db.transaction(CACHE)
  const index = tx.objectStore(CACHE).index(CACHE_ACCESS_INDEX)
  const cursor = await request(index.openCursor(after ? IDBKeyRange.lowerBound(after, true) : null))
  return cursor ? { db, key: cursor.key, access: cursor.value } : null
}

async function evict (dbs, limits, { maxDeleted = 25, maxExamined = 100, onStats } = {}) {
  let totals = await sumUsage(dbs)
  if (!cacheExcess(totals, limits)) return totals
  const target = Object.fromEntries(['cacheBytes', 'cacheCount'].map(key => [key, Math.floor(limits[key] * 0.9)]))
  const heads = (await Promise.all(dbs.map(db => nextAccess(db)))).filter(Boolean)
  let examined = 0
  let deleted = 0
  while (heads.length && examined < maxExamined && deleted < maxDeleted && cacheExcess(totals, target)) {
    const batch = new Map()
    let selected = 0
    const projected = { ...totals }
    while (heads.length && examined < maxExamined && selected < Math.min(100, maxDeleted - deleted) && cacheExcess(projected, target)) {
      heads.sort((a, b) => a.access.lastAccessAt - b.access.lastAccessAt || indexedDB.cmp(a.db.name, b.db.name) || indexedDB.cmp(a.access.i, b.access.i))
      const candidate = heads.shift()
      examined++
      const next = candidate.refreshed ? null : await nextAccess(candidate.db, candidate.key)
      if (next) heads.push(next)
      const row = await request(candidate.db.transaction(EVENTS_STORE).objectStore(EVENTS_STORE).get(candidate.access.i))
      if (!row) continue
      projected.cacheBytes -= row.eventBytes
      projected.cacheCount--
      const ids = batch.get(candidate.db) ?? []
      ids.push(candidate)
      batch.set(candidate.db, ids)
      selected++
    }
    for (const [db, ids] of batch) {
      deleted += await mutate(db, async tx => {
        let count = 0
        for (const candidate of ids) {
          const id = candidate.access.i
          const access = await request(tx.objectStore(CACHE).get(id))
          const row = await request(tx.objectStore(EVENTS_STORE).get(id))
          if (!access || !row || !foreignPublic(db, row) || await isOwnerReferenced(db, tx, row)) continue
          if (access.lastAccessAt !== candidate.access.lastAccessAt) {
            // Re-enter LRU selection with the committed timestamp. Selection
            // may race with touches, but deletion shares their IDB store lock.
            heads.push({ db, access, key: [access.lastAccessAt, access.i], refreshed: true })
            continue
          }
          await deleteStoredEvent(db, tx, row)
          count++
        }
        return count
      })
    }
    totals = await sumUsage(dbs)
  }
  onStats?.({ examined, deleted, exhausted: heads.length === 0 })
  return totals
}

export async function withQuotaMutation (db, callback, { admission = false, beforeMutation, onTiming } = {}) {
  const startedAt = performance.now()
  const connection = captureNostrDbConnection(ownerFromDb(db))
  const check = () => {
    assertNostrDbAccess(ownerFromDb(db))
    beforeMutation?.()
    if (!connection?.isCurrent()) throw Object.assign(new Error('NOSTRDB_RESET'), { code: 'NOSTRDB_RESET' })
  }
  try {
    check()
    await initializeUsage(db)
    check()
    const blocked = admission ? quotaBlocks(readQuotaState()?.totals, getNostrDbQuotaLimits()) : null
    return await mutate(db, tx => { check(); return callback(tx) }, blocked)
  } finally {
    const measure = { stage: 'quota-mutation', elapsedMs: performance.now() - startedAt, category: admission ? 'admission' : 'mutation' }
    try {
      if (onTiming) onTiming(measure)
      else recordPerformance(measure)
    } catch {}
  }
}

export function queueCacheAccess (owner, events) {
  let connection
  try { connection = captureNostrDbConnection(owner) } catch (error) {
    if (isNostrDbAccessError(error)) return
    throw error
  }
  if (!connection) return
  for (const event of events) {
    if (!event || typeof event !== 'object' || isPersonalCopyEvent(event) || event.pubkey === owner) continue
    const i = eventIdIndexKey(event.id)
    const key = `${owner}:${i}`
    touchQueue.delete(key)
    touchQueue.set(key, { owner, connection, i, time: Date.now() })
    if (touchQueue.size > 2048) touchQueue.delete(touchQueue.keys().next().value)
  }
  scheduleTouches()
}

function scheduleTouches () {
  if (touchTimer || touchRunning || !touchQueue.size) return
  touchTimer = setTimeout(() => { touchTimer = null; flushCacheAccess().catch(() => {}) }, 250)
  touchTimer.unref?.()
}

export async function flushCacheAccess () {
  if (touchRunning) return
  if (touchTimer) clearTimeout(touchTimer)
  touchTimer = null
  touchRunning = true
  const batch = [...touchQueue.entries()].slice(0, 100)
  for (const [key] of batch) touchQueue.delete(key)
  try {
    const groups = new Map()
    for (const [, item] of batch) {
      const group = groups.get(item.connection.generation) ?? []
      group.push(item)
      groups.set(item.connection.generation, group)
    }
    for (const items of groups.values()) {
      for (let offset = 0; offset < items.length; offset += 25) {
        const diagnostic = typeof IS_DEVELOPMENT !== 'undefined' && IS_DEVELOPMENT
        const startedAt = diagnostic ? performance.now() : 0
        const chunk = items.slice(offset, offset + 25)
        const connection = chunk[0].connection
        let tx, done, executingAt
        try {
          const db = await connection.resolve()
          if (!db || !connection.isCurrent()) continue
          tx = db.transaction(CACHE, 'readwrite')
          done = transactionDone(tx)
          const store = tx.objectStore(CACHE)
          const updates = []
          for (const item of chunk) {
            if (item.connection.generation !== connection.generation) continue
            updates.push(new Promise((resolve, reject) => {
              const read = store.get(item.i)
              read.onerror = () => reject(read.error)
              read.onsuccess = () => {
                if (diagnostic && executingAt === undefined) executingAt = performance.now()
                const access = read.result
                if (!access || item.time - access.lastAccessAt < 60000) {
                  resolve()
                  return
                }
                const update = store.put({ ...access, lastAccessAt: item.time })
                update.onerror = () => reject(update.error)
                update.onsuccess = () => resolve()
              }
            }))
          }
          // Keep all reads in flight inside this transaction. Dependent writes
          // start from each success handler before JavaScript can yield.
          await Promise.all(updates)
          await done
        } catch (error) {
          try { tx?.abort() } catch {}
          await done?.catch(() => {})
          if (!isNostrDbAccessError(error) && error.name !== 'InvalidStateError') throw error
        } finally {
          if (diagnostic) {
            recordPerformance({ stage: 'cache-access-wait', elapsedMs: (executingAt ?? performance.now()) - startedAt, count: chunk.length })
            recordPerformance({ stage: 'cache-access-execution', elapsedMs: performance.now() - (executingAt ?? performance.now()), count: chunk.length })
          }
        }
        // Give foreground work an opportunity between small auxiliary writes.
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    }
  } finally { touchRunning = false; scheduleTouches() }
}

export function maintainNostrDbCache () {
  return reviewQuotaUsage(true)
}

export function scheduleQuotaMaintenance (demand) {
  maintenance?.wake(demand)
}

export function startGlobalQuotaMaintenance () {
  if (maintenance) return maintenance.stop
  reloadQuotaState()
  if (typeof BroadcastChannel === 'function') {
    try {
      channel = new BroadcastChannel('44billion:nostrdb-quota:v1')
      channel.unref?.()
      channel.onmessage = ({ data }) => {
        if (data?.type === 'state') reloadQuotaState()
        if (data?.type === 'dirty') maintenance?.wake({ remote: true, immediate: data.urgent === true })
      }
    } catch { recordPerformance({ stage: 'quota-state-notify-failed' }) }
  }
  const scheduler = createQuotaScheduler({
    review: () => reviewQuotaUsage(true, true),
    notify: urgent => broadcastQuotaMessage({ type: 'dirty', urgent })
  })
  const refresh = () => { reloadQuotaState(); scheduler.wake({ immediate: true }) }
  const onStorage = event => {
    if (event.key === STATE_KEY) reloadQuotaState()
    if (event.key === null || event.key === SETTINGS_KEY) refresh()
  }
  globalThis.addEventListener?.('storage', onStorage)
  globalThis.addEventListener?.('focus', refresh)
  globalThis.document?.addEventListener('visibilitychange', refresh)
  maintenance = {
    wake: scheduler.wake,
    stop () {
      scheduler.stop()
      globalThis.removeEventListener?.('storage', onStorage)
      globalThis.removeEventListener?.('focus', refresh)
      globalThis.document?.removeEventListener('visibilitychange', refresh)
      channel?.close()
      channel = maintenance = null
      resetQuotaStateMemory()
    }
  }
  return maintenance.stop
}
