import {
  NOSTRDB_REMOVAL_AUDIT_BY_AT,
  NOSTRDB_REMOVAL_AUDIT_MAX_BYTES,
  NOSTRDB_REMOVAL_AUDIT_MAX_ENTRIES,
  NOSTRDB_REMOVAL_AUDIT_STATE_KEY,
  NOSTRDB_REMOVAL_AUDIT_STATE_STORE,
  NOSTRDB_REMOVAL_AUDIT_STORE,
  NOSTRDB_REMOVAL_AUDIT_TTL_MS
} from '#constants/storage-schema.js'
import { run } from '#services/idb/browser/index.js'

const DAY_MS = 24 * 60 * 60 * 1000
const encoder = new TextEncoder()

export const REMOVAL_AUDIT_SOURCES = Object.freeze([
  'app-remove',
  'replaceable-merge',
  'personal-copy-crdt',
  'deletion-request',
  'deletion-request-prune',
  'expiration',
  'hearsay-prune',
  'chunk-purge',
  'chunk-invalid',
  'unclaimed-app-data',
  'app-data-cleanup',
  'cache-eviction'
])

const SOURCE_SET = new Set(REMOVAL_AUDIT_SOURCES)
const TARGET_TYPES = new Set(['e', 'a'])

function normalizedString (value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function normalizeTargets (stored, targets) {
  const eventId = stored?.event?.id
  const normalized = Array.isArray(targets)
    ? targets
      .filter(target => Array.isArray(target) && target.length === 2)
      .map(([type, value]) => [type, normalizedString(value, 2048)])
      .filter(([type, value]) => TARGET_TYPES.has(type) && value)
    : []
  if (normalized.length) return normalized
  return eventId ? [['e', eventId]] : []
}

function recordBytes (record) {
  return encoder.encode(JSON.stringify(record)).byteLength
}

async function readState (db, tx) {
  const stored = await run('get', [NOSTRDB_REMOVAL_AUDIT_STATE_KEY], NOSTRDB_REMOVAL_AUDIT_STATE_STORE, null, { db, tx })
    .then(value => value.result)
  if (
    stored &&
    Number.isSafeInteger(stored.count) && stored.count >= 0 &&
    Number.isSafeInteger(stored.bytes) && stored.bytes >= 0 &&
    Number.isSafeInteger(stored.nextId) && stored.nextId > 0 &&
    Number.isFinite(stored.lastPrunedAt)
  ) return stored

  const records = await run('getAll', [], NOSTRDB_REMOVAL_AUDIT_STORE, null, { db, tx }).then(value => value.result)
  return {
    key: NOSTRDB_REMOVAL_AUDIT_STATE_KEY,
    count: records.length,
    bytes: records.reduce((sum, record) => sum + (Number(record.byteSize) || recordBytes(record)), 0),
    nextId: records.reduce((max, record) => Math.max(max, Number(record.id) || 0), 0) + 1,
    lastPrunedAt: 0
  }
}

async function removeAuditRecords (db, tx, state, records) {
  for (const record of records) {
    await run('delete', [record.id], NOSTRDB_REMOVAL_AUDIT_STORE, null, { db, tx })
    state.count = Math.max(0, state.count - 1)
    state.bytes = Math.max(0, state.bytes - (Number(record.byteSize) || recordBytes(record)))
  }
}

async function recordsByAt (db, tx, range = null) {
  const keys = await run(
    'getAllKeys',
    [range],
    NOSTRDB_REMOVAL_AUDIT_STORE,
    NOSTRDB_REMOVAL_AUDIT_BY_AT,
    { db, tx }
  ).then(value => value.result)
  const records = []
  for (const key of keys) {
    const record = await run('get', [key], NOSTRDB_REMOVAL_AUDIT_STORE, null, { db, tx }).then(value => value.result)
    if (record) records.push(record)
  }
  return records
}

// Runs inside the transaction that deleted the event. Any storage error must
// abort that transaction, keeping deletion and forensic provenance atomic.
export async function recordRemovalAudit ({
  db,
  tx,
  stored,
  appId = 'system',
  source,
  targets,
  now = Date.now()
}) {
  if (!SOURCE_SET.has(source)) throw new TypeError(`Invalid removal audit source: ${source}`)
  const targetList = normalizeTargets(stored, targets)
  if (!targetList.length || !stored?.event?.id) return

  const state = await readState(db, tx)
  if (now - state.lastPrunedAt >= DAY_MS) {
    const expired = await recordsByAt(
      db,
      tx,
      globalThis.IDBKeyRange.upperBound([
        now - NOSTRDB_REMOVAL_AUDIT_TTL_MS,
        Number.MAX_SAFE_INTEGER
      ])
    )
    await removeAuditRecords(db, tx, state, expired)
    state.lastPrunedAt = now
  }

  const records = targetList.map(([targetType, target]) => {
    const record = {
      id: state.nextId++,
      at: now,
      appId: normalizedString(appId, 512) || 'system',
      operation: 'delete-event',
      source,
      targetType,
      target,
      eventId: stored.event.id,
      resultCode: 'deleted',
      byteSize: 0
    }
    record.byteSize = recordBytes(record)
    const nextSize = recordBytes(record)
    if (nextSize !== record.byteSize) record.byteSize = nextSize
    return record
  })

  const addedBytes = records.reduce((sum, record) => sum + record.byteSize, 0)
  if (
    records.length > NOSTRDB_REMOVAL_AUDIT_MAX_ENTRIES ||
    addedBytes > NOSTRDB_REMOVAL_AUDIT_MAX_BYTES
  ) throw new Error('REMOVAL_AUDIT_LIMIT_EXCEEDED')

  for (const record of records) await run('put', [record], NOSTRDB_REMOVAL_AUDIT_STORE, null, { db, tx })
  state.count += records.length
  state.bytes += addedBytes

  if (state.count > NOSTRDB_REMOVAL_AUDIT_MAX_ENTRIES || state.bytes > NOSTRDB_REMOVAL_AUDIT_MAX_BYTES) {
    const all = await recordsByAt(db, tx)
    let cursor = 0
    while (
      cursor < all.length &&
      (state.count > NOSTRDB_REMOVAL_AUDIT_MAX_ENTRIES || state.bytes > NOSTRDB_REMOVAL_AUDIT_MAX_BYTES)
    ) {
      await removeAuditRecords(db, tx, state, [all[cursor++]])
    }
  }

  await run('put', [{ ...state, key: NOSTRDB_REMOVAL_AUDIT_STATE_KEY }], NOSTRDB_REMOVAL_AUDIT_STATE_STORE, null, { db, tx })
}
