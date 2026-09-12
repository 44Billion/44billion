import {
  NOSTRDB_CACHE_ACCESS_STORE as CACHE,
  NOSTRDB_MAINTENANCE_STORE as MAINTENANCE,
  NOSTRDB_QUOTA_USAGE_KEY as USAGE_KEY,
  NOSTRDB_QUOTA_SETTINGS_KEY as SETTINGS_KEY
} from '#constants/storage-schema.js'
import { isPersonalCopyEvent } from '#helpers/personal-copy.js'
import {
  NOSTRDB_PREFIX, EVENTS_STORE, DELETIONS_STORE, INDEX,
  openNostrDb, eventIdIndexKey, addressKey, getCoordinate, deleteStoredEvent
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

export class NostrDbQuotaError extends Error {
  constructor (category, delta, excluded) {
    super(`NostrDB ${category} quota exceeded`)
    this.code = 'quota'
    this.category = category
    this.delta = delta
    this.excluded = excluded
  }
}

function unavailable () {
  return Object.assign(new Error('NostrDB quota coordination is unavailable'), { code: 'unavailable' })
}

export function withNostrDbQuotaLock (callback) {
  if (!globalThis.navigator?.locks?.request) return Promise.reject(unavailable())
  return navigator.locks.request(QUOTA_LOCK, callback)
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
    return getNostrDbQuotaLimits()
  })
  scheduleQuotaMaintenance()
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
  const refs = new Set()
  for (const tag of event.tags) {
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

function prepareRecord (db, row) {
  row.eventBytes = encoder.encode(JSON.stringify(row.event)).byteLength
  row.ownerRefs = ownerReferenceKeys(row.event, db.name.slice(NOSTRDB_PREFIX.length))
  return row
}

function foreignPublic (db, row) {
  return !isPersonalCopyEvent(row.event) && row.event.pubkey !== db.name.slice(NOSTRDB_PREFIX.length)
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

function changeEventTotals (usage, row, sign) {
  const category = isPersonalCopyEvent(row.event) ? 'private' : 'public'
  usage[`${category}Bytes`] += sign * row.eventBytes
  usage[`${category}Count`] += sign
}

async function setCacheClassification (db, tx, row, usage, { initial = false } = {}) {
  const store = tx.objectStore(CACHE)
  const access = await request(store.get(row.i))
  const cached = foreignPublic(db, row) && !await isOwnerReferenced(db, tx, row)
  if (cached === !!access) return
  usage.cacheCount += cached ? 1 : -1
  usage.cacheBytes += (cached ? 1 : -1) * row.eventBytes
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
  while (true) {
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
          changeEventTotals(usage, row, 1)
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
    const db = await openNostrDb(name.slice(NOSTRDB_PREFIX.length), { quotaLockHeld: true })
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
  return withNostrDbQuotaLock(async () => sumUsage(await allDatabases()))
}

// Called from the common event deletion path, before its event row is removed.
export async function accountDeletedEvent (db, tx, row) {
  const ctx = contexts.get(tx)
  if (!ctx) throw new Error('Event deletion requires a quota transaction')
  changeEventTotals(ctx.usage, row, -1)
  const store = tx.objectStore(CACHE)
  if (await request(store.get(row.i))) {
    ctx.usage.cacheBytes -= row.eventBytes
    ctx.usage.cacheCount--
    await request(store.delete(row.i))
  }
  for (const ref of row.ownerRefs ?? []) ctx.refs.add(ref)
  ctx.excluded.add(row.i)
}

export async function putQuotaEvent (db, tx, row) {
  const ctx = contexts.get(tx)
  if (!ctx) throw new Error('Event insertion requires a quota transaction')
  prepareRecord(db, row)
  await request(tx.objectStore(EVENTS_STORE).put(row))
  changeEventTotals(ctx.usage, row, 1)
  await setCacheClassification(db, tx, row, ctx.usage)
  if (foreignPublic(db, row) && !await isOwnerReferenced(db, tx, row)) ctx.admitsCache = true
  for (const ref of row.ownerRefs) ctx.refs.add(ref)
  ctx.excluded.add(row.i)
}

async function reconcileChangedReferences (db, tx, ctx) {
  const store = tx.objectStore(EVENTS_STORE)
  for (const ref of ctx.refs) {
    let row
    if (ref.startsWith('e:')) row = await request(store.get(ref.slice(2)))
    else {
      const [, kind, pubkey, d] = ref.split(':')
      row = await request(store.index(INDEX.address).get([Number(kind), pubkey, d]))
    }
    if (row && foreignPublic(db, row)) await setCacheClassification(db, tx, row, ctx.usage)
  }
}

async function mutate (db, callback, admission) {
  const tx = db.transaction([EVENTS_STORE, DELETIONS_STORE, CACHE, MAINTENANCE], 'readwrite')
  const done = transactionDone(tx)
  try {
    const stateStore = tx.objectStore(MAINTENANCE)
    const usage = await request(stateStore.get(USAGE_KEY))
    if (usage?.phase !== 'ready') throw unavailable()
    const before = { ...usage }
    const ctx = { usage, refs: new Set(), excluded: new Set(), admitsCache: false }
    contexts.set(tx, ctx)
    const result = await callback(tx)
    await reconcileChangedReferences(db, tx, ctx)
    if (admission) {
      const delta = emptyTotals()
      for (const key of Object.keys(delta)) delta[key] = usage[key] - before[key]
      const { totals, limits } = admission
      if (ctx.admitsCache && ['cacheBytes', 'cacheCount'].some(key => delta[key] > 0 && totals[key] + delta[key] > limits[key])) {
        throw new NostrDbQuotaError('cache', delta, ctx.excluded)
      }
      for (const category of ['public', 'private']) {
        const key = `${category}Bytes`
        if (delta[key] > 0 && totals[key] + delta[key] > limits[key]) throw new NostrDbQuotaError(category)
      }
    }
    await request(stateStore.put(usage))
    await done
    return result
  } catch (error) {
    try { tx.abort() } catch {}
    await done.catch(() => {})
    throw error
  } finally {
    contexts.delete(tx)
  }
}

function cacheExcess (totals, limits, extra = {}) {
  return ['cacheBytes', 'cacheCount'].some(key => totals[key] + (extra[key] ?? 0) > limits[key])
}

async function nextAccess (db, after) {
  const tx = db.transaction(CACHE)
  const index = tx.objectStore(CACHE).index(CACHE_ACCESS_INDEX)
  const cursor = await request(index.openCursor(after ? IDBKeyRange.lowerBound(after, true) : null))
  return cursor ? { db, key: cursor.key, access: cursor.value } : null
}

async function evict (dbs, limits, { extra = {}, excludeDb, excluded = new Set(), maxDeleted = 1000 } = {}) {
  let totals = await sumUsage(dbs)
  if (!cacheExcess(totals, limits, extra)) return totals
  if (['cacheBytes', 'cacheCount'].some(key => (extra[key] ?? 0) > limits[key])) return totals
  const target = Object.fromEntries(['cacheBytes', 'cacheCount'].map(key => [key, Math.max(Math.floor(limits[key] * 0.9), extra[key] ?? 0)]))
  const heads = (await Promise.all(dbs.map(db => nextAccess(db)))).filter(Boolean)
  let examined = 0
  let deleted = 0
  while (heads.length && examined < 1000 && deleted < maxDeleted && cacheExcess(totals, target, extra)) {
    const batch = new Map()
    let selected = 0
    const projected = { ...totals }
    while (heads.length && examined < 1000 && selected < Math.min(100, maxDeleted - deleted) && cacheExcess(projected, target, extra)) {
      heads.sort((a, b) => a.access.lastAccessAt - b.access.lastAccessAt || indexedDB.cmp(a.db.name, b.db.name) || indexedDB.cmp(a.access.i, b.access.i))
      const candidate = heads.shift()
      examined++
      const next = await nextAccess(candidate.db, candidate.key)
      if (next) heads.push(next)
      if (candidate.db.name === excludeDb && excluded.has(candidate.access.i)) continue
      const row = await request(candidate.db.transaction(EVENTS_STORE).objectStore(EVENTS_STORE).get(candidate.access.i))
      if (!row) continue
      projected.cacheBytes -= row.eventBytes
      projected.cacheCount--
      const ids = batch.get(candidate.db) ?? []
      ids.push(candidate.access.i)
      batch.set(candidate.db, ids)
      selected++
    }
    for (const [db, ids] of batch) {
      deleted += await mutate(db, async tx => {
        let count = 0
        for (const id of ids) {
          const row = await request(tx.objectStore(EVENTS_STORE).get(id))
          if (!row || !foreignPublic(db, row) || await isOwnerReferenced(db, tx, row)) continue
          await deleteStoredEvent(db, tx, row)
          count++
        }
        return count
      })
    }
    totals = await sumUsage(dbs)
  }
  return totals
}

export function withQuotaMutation (db, callback, { admission = false, beforeMutation } = {}) {
  return withNostrDbQuotaLock(async () => {
    beforeMutation?.()
    if (!admission) {
      await initializeUsage(db)
      beforeMutation?.()
      return mutate(db, callback)
    }
    const dbs = await allDatabases()
    if (!dbs.some(candidate => candidate.name === db.name)) throw unavailable()
    const limits = getNostrDbQuotaLimits()
    let totals = await sumUsage(dbs)
    try {
      return await mutate(db, callback, { totals, limits })
    } catch (error) {
      if (!(error instanceof NostrDbQuotaError) || error.category !== 'cache') throw error
      totals = await evict(dbs, limits, { extra: error.delta, excludeDb: db.name, excluded: error.excluded })
      return mutate(db, callback, { totals, limits })
    }
  }).finally(scheduleQuotaMaintenance)
}

export function queueCacheAccess (owner, events) {
  for (const event of events) {
    if (!event || typeof event !== 'object' || isPersonalCopyEvent(event) || event.pubkey === owner) continue
    const i = eventIdIndexKey(event.id)
    const key = `${owner}:${i}`
    touchQueue.delete(key)
    touchQueue.set(key, { owner, i, time: Date.now() })
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
      const group = groups.get(item.owner) ?? []
      group.push(item)
      groups.set(item.owner, group)
    }
    for (const [owner, items] of groups) {
      await withNostrDbQuotaLock(async () => {
        // Do not reopen deleted databases to deliver pending statistics.
        if (typeof globalThis.indexedDB?.databases !== 'function') return
        if (!(await indexedDB.databases()).some(({ name }) => name === `${NOSTRDB_PREFIX}${owner}`)) return
        const db = await openNostrDb(owner, { quotaLockHeld: true })
        if (!db) return
        const tx = db.transaction(CACHE, 'readwrite')
        const done = transactionDone(tx)
        try {
          const store = tx.objectStore(CACHE)
          for (const item of items) {
            const access = await request(store.get(item.i))
            if (!access || item.time - access.lastAccessAt < 60000) continue
            await request(store.put({ ...access, lastAccessAt: item.time }))
          }
          await done
        } catch (error) {
          try { tx.abort() } catch {}
          await done.catch(() => {})
          throw error
        }
      })
    }
  } finally { touchRunning = false; scheduleTouches() }
}

export function maintainNostrDbCache () {
  return withNostrDbQuotaLock(async () => {
    const limits = getNostrDbQuotaLimits()
    const totals = await evict(await allDatabases(), limits, { maxDeleted: 100 })
    return { excess: cacheExcess(totals, limits) }
  })
}

function scheduleQuotaMaintenance () {
  maintenance?.wake()
}

export function startGlobalQuotaMaintenance () {
  if (maintenance) return maintenance.stop
  let timer
  let stopped = false
  let running = false
  let due = Infinity
  const schedule = delay => {
    if (stopped || Date.now() + delay >= due) return
    due = Date.now() + delay
    clearTimeout(timer)
    timer = setTimeout(tick, delay)
    timer.unref?.()
  }
  const tick = async () => {
    if (stopped || running) return
    running = true
    due = Infinity
    let delay = 60000
    try { if ((await maintainNostrDbCache()).excess) delay = 1000 } catch {} finally { running = false; schedule(delay) }
  }
  const stop = () => {
    stopped = true
    clearTimeout(timer)
    if (maintenance?.stop === stop) maintenance = null
  }
  maintenance = { stop, wake: () => { if (!running) schedule(1000) } }
  schedule(1000)
  return stop
}
