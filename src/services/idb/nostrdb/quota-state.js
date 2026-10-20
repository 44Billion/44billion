import { NOSTRDB_QUOTA_STATE_KEY } from '#constants/storage-schema.js'

export const quotaCategories = ['public', 'private', 'cache']
export const quotaTotalKeys = quotaCategories.flatMap(category => [`${category}Bytes`, `${category}Count`])
const listeners = new Set()
let current
let loaded = false

export function quotaBlocks (totals, limits) {
  return Object.fromEntries(quotaCategories.map(category => [category,
    limits[`${category}Bytes`] === 0 || (category === 'cache' && limits.cacheCount === 0) ||
    !!(totals && (totals[`${category}Bytes`] > limits[`${category}Bytes`] ||
      (category === 'cache' && totals.cacheCount > limits.cacheCount)))
  ]))
}

export function quotaNeedsAttention (state) {
  return !!(state?.totals && (state.totals.publicBytes > state.limits.publicBytes ||
    state.totals.privateBytes > state.limits.privateBytes || (state.maintenance.cacheAttention &&
      (state.totals.cacheBytes > state.limits.cacheBytes || state.totals.cacheCount > state.limits.cacheCount))))
}

export function isQuotaState (state) {
  return state?.version === 1 && Number.isSafeInteger(state.revision) && state.revision > 0 &&
    Number.isSafeInteger(state.checkedAt) && state.checkedAt >= 0 && Number.isSafeInteger(state.maintenance?.startedAt) && state.maintenance.startedAt >= 0 &&
    Number.isSafeInteger(state.maintenance.failureCount ?? 0) && (state.maintenance.failureCount ?? 0) >= 0 && (state.maintenance.failureCount ?? 0) <= 6 &&
    Number.isSafeInteger(state.maintenance.retryAt ?? 0) && (state.maintenance.retryAt ?? 0) >= 0 &&
    typeof state.maintenance.failed === 'boolean' && typeof state.maintenance.cacheAttention === 'boolean' &&
    ['publicBytes', 'privateBytes', 'cacheBytes', 'cacheCount'].every(key => Number.isSafeInteger(state.limits?.[key]) && state.limits[key] >= 0) &&
    (state.totals === null || quotaTotalKeys.every(key => Number.isSafeInteger(state.totals?.[key]) && state.totals[key] >= 0))
}

export function reloadQuotaState () {
  loaded = true
  try {
    const next = JSON.parse(globalThis.localStorage?.getItem(NOSTRDB_QUOTA_STATE_KEY) ?? 'null')
    if (isQuotaState(next) && (!current || next.revision > current.revision)) {
      current = { ...next, blocked: quotaBlocks(next.totals, next.limits) }
      for (const listener of listeners) { try { listener(readQuotaState()) } catch {} }
    }
  } catch {}
  return readQuotaState()
}

export function readQuotaState () {
  if (!loaded) return reloadQuotaState()
  return current ? structuredClone(current) : null
}

// The caller owns QUOTA_LOCK. Persist before exposing the new revision.
export function publishQuotaState ({ totals, limits, checkedAt, maintenance }) {
  reloadQuotaState()
  const next = structuredClone({
    version: 1, revision: (current?.revision ?? 0) + 1,
    totals: totals === undefined ? current?.totals ?? null : totals,
    limits, checkedAt: checkedAt ?? current?.checkedAt ?? 0,
    maintenance: { startedAt: 0, failed: false, cacheAttention: false, failureCount: 0, retryAt: 0, ...current?.maintenance, ...maintenance }
  })
  if (!isQuotaState(next)) throw new Error('Invalid quota summary')
  next.blocked = quotaBlocks(next.totals, limits)
  if (!globalThis.localStorage) throw new Error('Quota state storage unavailable')
  localStorage.setItem(NOSTRDB_QUOTA_STATE_KEY, JSON.stringify(next))
  current = next
  for (const listener of listeners) { try { listener(readQuotaState()) } catch {} }
  return readQuotaState()
}

export function subscribeQuotaState (listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// A failed lock/storage operation cannot safely publish a durable revision.
// Notify the mounted UI without replacing the last usable persisted snapshot.
export function reportQuotaStateFailure () {
  const state = readQuotaState()
  const failed = { ...state, maintenance: { ...state?.maintenance, failed: true, cacheAttention: !!state?.blocked.cache } }
  for (const listener of listeners) { try { listener(structuredClone(failed)) } catch {} }
}

export function resetQuotaStateMemory () { current = undefined; loaded = false }

// One instance per execution context; the review itself coordinates other tabs.
export function createQuotaScheduler ({ review, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, notify = () => {} }) {
  let timer
  let due = Infinity
  let running = false
  let stopped = false
  let dirty = false
  let mutations = 0
  let bytes = 0
  let lastStart = -Infinity
  let failureDelay = 0
  let retryAt = 0
  const schedule = delay => {
    const target = Math.max(now() + delay, lastStart + 250, retryAt)
    if (stopped || running || target >= due) return
    due = target
    clearTimer(timer)
    timer = setTimer(tick, Math.max(0, target - now()))
    timer?.unref?.()
  }
  const tick = async () => {
    if (stopped) return
    running = true
    due = Infinity
    dirty = false
    mutations = bytes = 0
    lastStart = now()
    let delay = 60000
    try {
      const result = await review()
      if (result.deferMs) {
        dirty = true
        delay = result.deferMs
        retryAt = now() + delay
      } else {
        failureDelay = retryAt = 0
        if (result.excess) delay = 1000
      }
    } catch {
      failureDelay = Math.min(30000, failureDelay ? failureDelay * 2 : 1000)
      retryAt = now() + failureDelay
      delay = failureDelay
    } finally {
      running = false
      schedule(dirty ? Math.min(delay, mutations >= 64 || bytes >= 4 * 1024 * 1024 ? 0 : 1000) : delay)
    }
  }
  const wake = ({ count = 0, volume = 0, remote = false, immediate = false } = {}) => {
    const wasDirty = dirty
    dirty = true
    mutations += count
    bytes += volume
    const urgent = immediate || mutations >= 64 || bytes >= 4 * 1024 * 1024
    const previousDue = due
    schedule(urgent ? 0 : 1000)
    if (!remote && (due < previousDue || (running && !wasDirty))) notify(urgent)
  }
  schedule(1000)
  return {
    wake,
    stop () { stopped = true; clearTimer(timer) }
  }
}
