const KEY = '44billion:vault-accepted-message-queue:v1'
const LEGACY_APP_BACKFILL_KEY = '44billion:nostrdb-app-backfill-queue:v1'
const NOSTRDB_APP_BACKFILL_CODE = 'NOSTRDB_APP_BACKFILL'
const HEX32 = /^[0-9a-f]{64}$/i
const MAX_ITEMS = 100
const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000
const RETRY_THROTTLE_MS = 30 * 1000
const REQUEST_TIMEOUT_MS = 5000
const APP_ID_MAX_LENGTH = 512

const MESSAGE_CONFIGS = {
  [NOSTRDB_APP_BACKFILL_CODE]: {
    normalizePayload (payload) {
      if (!payload || typeof payload !== 'object') return null
      const ownerPubkey = typeof payload.ownerPubkey === 'string' ? payload.ownerPubkey.toLowerCase() : ''
      const appId = typeof payload.appId === 'string' ? payload.appId : ''
      if (!HEX32.test(ownerPubkey) || !appId || appId.length > APP_ID_MAX_LENGTH) return null
      return { ownerPubkey, appId }
    },
    dedupeKey: payload => `${payload.ownerPubkey}:${payload.appId}`
  }
}

let flushPromise = null

function nowMs () {
  return Date.now()
}

function messageConfig (code) {
  return MESSAGE_CONFIGS[code] || null
}

function itemKey (item) {
  const config = messageConfig(item.code)
  return config ? `${item.code}:${config.dedupeKey(item.payload)}` : ''
}

function normalizeTimestamp (value, fallback = nowMs()) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function normalizeItem (value) {
  if (!value || typeof value !== 'object') return null
  const code = typeof value.code === 'string' ? value.code : ''
  const config = messageConfig(code)
  if (!config) return null
  const payload = config.normalizePayload(value.payload)
  if (!payload) return null
  return {
    code,
    payload,
    createdAt: normalizeTimestamp(value.createdAt),
    lastAttemptAt: normalizeTimestamp(value.lastAttemptAt, 0)
  }
}

function normalizeLegacyAppBackfillItem (value) {
  if (!value || typeof value !== 'object') return null
  return normalizeItem({
    code: NOSTRDB_APP_BACKFILL_CODE,
    payload: {
      ownerPubkey: value.ownerPubkey,
      appId: value.appId
    },
    createdAt: value.createdAt,
    lastAttemptAt: value.lastAttemptAt
  })
}

function parseQueue (storage, key, normalize) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(key) || '[]')
    return Array.isArray(parsed) ? parsed.map(normalize).filter(Boolean) : []
  } catch {
    return []
  }
}

function readStoredQueue (storage = globalThis.localStorage) {
  return parseQueue(storage, KEY, normalizeItem)
}

function readLegacyQueue (storage = globalThis.localStorage) {
  return parseQueue(storage, LEGACY_APP_BACKFILL_KEY, normalizeLegacyAppBackfillItem)
}

function writeQueue (items, storage = globalThis.localStorage) {
  const normalized = items.map(normalizeItem).filter(Boolean)
  if (!normalized.length) {
    storage?.removeItem?.(KEY)
    return
  }
  storage?.setItem?.(KEY, JSON.stringify(normalized))
}

function pruneQueue (items, now = nowMs()) {
  const deduped = new Map()
  for (const item of items) {
    if (now - item.createdAt > SIX_MONTHS_MS) continue
    const key = itemKey(item)
    if (!key) continue
    const current = deduped.get(key)
    if (!current || item.createdAt < current.createdAt) deduped.set(key, item)
  }
  return [...deduped.values()]
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(-MAX_ITEMS)
}

function readQueue (storage = globalThis.localStorage, now = nowMs()) {
  const queue = pruneQueue([
    ...readStoredQueue(storage),
    ...readLegacyQueue(storage)
  ], now)
  writeQueue(queue, storage)
  storage?.removeItem?.(LEGACY_APP_BACKFILL_KEY)
  return queue
}

function removeItem (items, itemToRemove) {
  const key = itemKey(itemToRemove)
  return items.filter(item => itemKey(item) !== key)
}

export function enqueueVaultAcceptedMessage (message, {
  storage = globalThis.localStorage,
  now = nowMs()
} = {}) {
  const normalized = normalizeItem({ ...message, createdAt: now, lastAttemptAt: 0 })
  if (!normalized) return false
  const queue = readQueue(storage, now)
  if (queue.some(existing => itemKey(existing) === itemKey(normalized))) {
    writeQueue(queue, storage)
    return true
  }
  queue.push(normalized)
  writeQueue(pruneQueue(queue, now), storage)
  return true
}

export function readVaultAcceptedMessageQueue ({ storage = globalThis.localStorage, now = nowMs() } = {}) {
  return readQueue(storage, now)
}

export async function flushVaultAcceptedMessageQueue ({
  vaultPort,
  storage = globalThis.localStorage,
  ask,
  now = nowMs,
  timeout = REQUEST_TIMEOUT_MS
} = {}) {
  if (!vaultPort || typeof ask !== 'function') return false
  if (flushPromise) return flushPromise
  flushPromise = (async () => {
    let flushed = false
    let queue = readVaultAcceptedMessageQueue({ storage, now: now() })
    for (const item of queue) {
      const currentNow = now()
      queue = readVaultAcceptedMessageQueue({ storage, now: currentNow })
      const current = queue.find(candidate => itemKey(candidate) === itemKey(item))
      if (!current) continue
      if (current.lastAttemptAt && currentNow - current.lastAttemptAt < RETRY_THROTTLE_MS) continue

      current.lastAttemptAt = currentNow
      writeQueue(queue, storage)

      let response
      try {
        response = await ask(vaultPort, {
          code: current.code,
          payload: current.payload
        }, { timeout })
      } catch (err) {
        response = { error: err }
      }

      if (response?.error || typeof response?.payload?.accepted !== 'boolean') continue
      queue = removeItem(readStoredQueue(storage), current)
      writeQueue(pruneQueue(queue, now()), storage)
      flushed = true
    }
    return flushed
  })().finally(() => {
    flushPromise = null
  })
  return flushPromise
}

export const vaultAcceptedMessageQueueInternals = {
  KEY,
  LEGACY_APP_BACKFILL_KEY,
  MAX_ITEMS,
  SIX_MONTHS_MS,
  RETRY_THROTTLE_MS,
  NOSTRDB_APP_BACKFILL_CODE
}
