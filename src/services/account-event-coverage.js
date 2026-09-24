import { normalizeRelayUrl } from 'libp2r2p/url'
import { openNostrDb } from '#services/idb/nostrdb/index.js'
import { invalidAccountCoverageKeys } from '#services/storage-audit/audit.js'
import {
  NOSTRDB_MAINTENANCE_STORE as STORE,
  NOSTRDB_ACCOUNT_COVERAGE_PREFIX as PREFIX,
  NOSTRDB_ACCOUNT_COVERAGE_REGISTRY as REGISTRY
} from '#constants/storage-schema.js'

const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})
const keyFor = (relay, kind) => PREFIX + JSON.stringify([relay, kind])
const invalidated = () => Object.assign(new Error('Account event coverage was reset'), { code: 'ACCOUNT_COVERAGE_RESET' })

export function mergeCoverage (ranges) {
  const result = []
  for (const [since, until] of ranges.toSorted((a, b) => a[0] - b[0])) {
    const last = result.at(-1)
    if (last && since <= last[1] + 1) last[1] = Math.max(last[1], until)
    else result.push([since, until])
  }
  return result
}

export function missingCoverage (intervals, since, until) {
  const gaps = []
  for (const [start, end] of intervals) {
    if (end < since) continue
    if (start > until) break
    if (start > since) gaps.push([since, start - 1])
    since = Math.max(since, end + 1)
  }
  if (since <= until) gaps.push([since, until])
  return gaps.reverse()
}

// All read-modify-write operations use one IDB readwrite transaction, serializing
// concurrent tabs without a process-local lock. Event commits precede checkpoint
// commits; a crash in between repeats a page. The generation fences DB resets.
export function createAccountEventCoverage (owner, { open = () => openNostrDb(owner) } = {}) {
  let selectedKinds = []
  async function transaction (work, signal) {
    signal?.throwIfAborted()
    const db = await open()
    if (!db) throw new Error('Account event storage unavailable')
    signal?.throwIfAborted()
    const tx = db.transaction(STORE, 'readwrite')
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onabort = () => reject(tx.error ?? new Error('Account coverage transaction aborted'))
      tx.onerror = () => {} // onabort owns the rejection
    })
    done.catch(() => {})
    const abort = () => { try { tx.abort() } catch {} }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const value = await work(tx.objectStore(STORE))
      signal?.throwIfAborted()
      await done
      return value
    } catch (error) {
      abort()
      await done.catch(() => {})
      throw error
    } finally { signal?.removeEventListener('abort', abort) }
  }
  async function registry (store) {
    let row = await request(store.get(REGISTRY))
    if (row?.version !== 1 || typeof row.generation !== 'string' || !Array.isArray(row.kinds)) {
      row = { key: REGISTRY, version: 1, generation: crypto.randomUUID(), kinds: selectedKinds }
      store.put(row)
    }
    return row
  }
  return {
    async reconcile (kinds, signal) {
      selectedKinds = [...new Set(kinds)].sort((a, b) => a - b)
      await transaction(async store => {
        const row = await registry(store)
        row.kinds = selectedKinds
        store.put(row)
        const records = await request(store.getAll())
        for (const key of invalidAccountCoverageKeys(records, row)) store.delete(key)
        // Kinds are registered even before the first relay is known. Per-relay
        // records are created on read, while retired relay coverage is retained.
      }, signal)
    },
    async read (relay, kinds, signal) {
      relay = normalizeRelayUrl(relay)
      return transaction(async store => {
        const row = await registry(store)
        const results = []
        for (const kind of kinds) {
          if (!row.kinds.includes(kind)) throw invalidated()
          const key = keyFor(relay, kind)
          let record = await request(store.get(key))
          if (!record || invalidAccountCoverageKeys([record], row).length) {
            record = { key, version: 1, generation: row.generation, relay, kind, intervals: [] }
            store.put(record)
          }
          results.push(record)
        }
        return results
      }, signal)
    },
    async mark (records, since, until, signal) {
      if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || since < 0 || until < since) throw new Error('Invalid account coverage interval')
      return transaction(async store => {
        // Do not recreate a missing registry here: a reset invalidates work that
        // committed its events in the old database.
        const row = await request(store.get(REGISTRY))
        for (const record of records) {
          if (!row || row.generation !== record.generation || !row.kinds.includes(record.kind)) throw invalidated()
          const current = await request(store.get(record.key))
          if (!current || current.generation !== record.generation) throw invalidated()
          store.put({ ...current, intervals: mergeCoverage([...current.intervals, [since, until]]) })
        }
      }, signal)
    }
  }
}
