import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'
import { finalizeEvent } from 'libp2r2p/event'
import { getPublicKey } from 'libp2r2p/key'
import { base16ToBase62 } from 'libp2r2p/base62'
import { encryptBytes, decryptBytes } from 'libp2r2p/nip44-v3'
import { createLocalPersonalCopy } from '#services/idb/nostrdb/personal-copy.js'
import { runNostrDbMethod } from '#helpers/window-message/browser/nostrdb.js'
import { buildPersonalCopyUnsignedEvent, personalCopySourceId } from '#helpers/personal-copy.js'
import {
  getNostrDb, openNostrDb, deleteNostrDb, deletionEventRef, eventIdIndexKey,
  NOSTRDB_PREFIX, NOSTRDB_VERSION, toStoredRecord
} from '#services/idb/nostrdb/index.js'
import {
  DEFAULT_NOSTRDB_QUOTAS, getNostrDbQuotaUsage, setNostrDbQuotaLimits,
  maintainNostrDbCache, queueCacheAccess, flushCacheAccess, ownerReferenceKeys,
  startGlobalQuotaMaintenance, cacheEventLimit, getNostrDbQuotaLimits, withNostrDbQuotaLock, readQuotaState
} from '#services/idb/nostrdb/quotas.js'

globalThis.indexedDB = indexedDB
globalThis.IDBKeyRange = IDBKeyRange
const settings = new Map()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true, value: {
    getItem: key => settings.get(key) ?? null,
    setItem: (key, value) => settings.set(key, value)
  }
})
let seed = 10
let serial = 0
const owners = []
const foreignSecret = new Uint8Array(32).fill(2)
const APP = `a${'1'.repeat(43)}one`
const byteSize = event => new TextEncoder().encode(JSON.stringify(event)).length
function signed (overrides = {}, secret = foreignSecret) {
  return finalizeEvent({ kind: 1, tags: [], created_at: 100 + serial++, content: '', ...overrides }, secret)
}
async function owner () {
  const secret = new Uint8Array(32).fill(seed++)
  const pubkey = getPublicKey(secret)
  owners.push(pubkey)
  const db = getNostrDb(pubkey, { maintenance: false })
  const raw = await openNostrDb(pubkey)
  return { pubkey, secret, db, raw }
}
function request (req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function access (raw, event) {
  return request(raw.transaction('cacheAccess').objectStore('cacheAccess').get(eventIdIndexKey(event.id)))
}
async function row (raw, event) {
  return request(raw.transaction('events').objectStore('events').get(eventIdIndexKey(event.id)))
}
async function limits (values) {
  await getNostrDbQuotaUsage()
  return setNostrDbQuotaLimits(values)
}
afterEach(async () => {
  startGlobalQuotaMaintenance()()
  await flushCacheAccess()
  for (const pubkey of owners.splice(0)) assert.equal(await deleteNostrDb(pubkey), true)
  settings.clear()
})

it('uses global defaults and charges UTF-8 event bytes across owners', async () => {
  assert.equal(DEFAULT_NOSTRDB_QUOTAS.publicBytes, 512 * 1024 * 1024)
  const a = await owner()
  const b = await owner()
  const first = signed({ content: 'ação 🌍' }, a.secret)
  const second = signed({ content: 'another owner' }, b.secret)
  await limits({ publicBytes: byteSize(first) + byteSize(second) })
  assert.equal((await a.db.add(first)).ok, true)
  assert.equal((await b.db.add(second)).ok, true)
  assert.equal((await getNostrDbQuotaUsage()).publicBytes, byteSize(first) + byteSize(second))
  assert.equal((await a.db.add(signed({}, a.secret))).stored, true, 'one admission can exceed the last reviewed total')
  await getNostrDbQuotaUsage()
  const refused = await a.db.add(signed({}, a.secret))
  assert.equal(refused.code, 'quota')
  assert.equal(refused.quotaCategory, 'public')
  assert.equal((await row(a.raw, first)).eventBytes, byteSize(first))
  assert.equal((await a.db.add(first)).code, 'duplicate')
})

it('admits concurrent growth then blocks it after a global review', async () => {
  const a = await owner()
  const b = await owner()
  const first = signed({}, a.secret)
  const second = signed({}, b.secret)
  await limits({ publicBytes: Math.max(byteSize(first), byteSize(second)) })
  const results = await Promise.all([a.db.add(first), b.db.add(second)])
  assert.equal(results.filter(result => result.stored).length, 2)
  assert.equal((await getNostrDbQuotaUsage()).publicCount, 2)
  assert.equal((await a.db.add(signed({}, a.secret))).quotaCategory, 'public')
})

it('writes and deletes across open banks without enumeration or the occupied maintenance lock', async t => {
  const a = await owner()
  const b = await owner()
  const acquired = Promise.withResolvers()
  const release = Promise.withResolvers()
  const held = withNostrDbQuotaLock(async () => { acquired.resolve(); await release.promise })
  await acquired.promise
  const mock = t.mock.method(indexedDB, 'databases', () => assert.fail('foreground mutation enumerated databases'))
  const first = signed({}, a.secret)
  const second = signed({}, b.secret)
  const operation = async () => {
    assert.ok((await a.db.add(first)).stored)
    assert.ok((await b.db.add(second)).stored)
    assert.equal((await a.db.remove([['e', first.id]])).deleted, 1)
    assert.equal((await b.db.remove([['e', second.id]])).deleted, 1)
  }
  let timeout
  try {
    await Promise.race([operation(), new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('mutation waited for maintenance lock')), 2000) })])
  } finally {
    clearTimeout(timeout)
    mock.mock.restore()
    release.resolve()
    await held
  }
  assert.equal((await getNostrDbQuotaUsage()).publicCount, 0)
})

it('keeps known gates during review failure and unlocks growth after deletion or a limit increase', async t => {
  const a = await owner()
  const own = signed({}, a.secret)
  await limits({ publicBytes: 1 })
  assert.equal((await a.db.add(own)).stored, true)
  await getNostrDbQuotaUsage()
  const failing = t.mock.method(indexedDB, 'databases', async () => { throw new Error('offline database enumeration') })
  await assert.rejects(getNostrDbQuotaUsage())
  assert.equal((await a.db.add(signed({}, a.secret))).quotaCategory, 'public')
  assert.equal((await a.db.add(signed())).stored, true, 'another category remains available')
  failing.mock.restore()
  await a.db.remove([['e', own.id]])
  await getNostrDbQuotaUsage()
  assert.equal((await a.db.add(signed({}, a.secret))).stored, true)
  const usage = await getNostrDbQuotaUsage()
  await setNostrDbQuotaLimits({ publicBytes: usage.publicBytes * 10 })
  assert.equal((await a.db.add(signed({}, a.secret))).stored, true, 'configuration reapplies gates immediately')
})

it('does not fail committed writes or valid reviews when broadcast notifications fail', async t => {
  const a = await owner()
  const stop = startGlobalQuotaMaintenance()
  t.after(stop)
  const postMessage = BroadcastChannel.prototype.postMessage
  t.mock.method(BroadcastChannel.prototype, 'postMessage', function (...args) {
    if (this.name === '44billion:nostrdb-quota:v1') throw new Error('channel unavailable')
    return postMessage.apply(this, args)
  })
  assert.equal((await a.db.add(signed({}, a.secret))).stored, true)
  assert.equal((await getNostrDbQuotaUsage()).publicCount, 1)
})

it('keeps the last complete aggregate when an existing bank becomes inaccessible', async () => {
  const a = await owner()
  const b = await owner()
  await a.db.add(signed({}, a.secret))
  await b.db.add(signed({}, b.secret))
  const previous = await getNostrDbQuotaUsage()
  const flag = `session_accountByUserPk_${base16ToBase62(b.pubkey, { mode: 'integer', minLength: 43 })}_isReadOnly`
  settings.set(flag, 'true')
  try {
    await assert.rejects(getNostrDbQuotaUsage(), { code: 'READ_ONLY_ACCOUNT' })
    assert.deepEqual(readQuotaState().totals, previous)
    assert.equal(readQuotaState().maintenance.failed, true)
  } finally { settings.delete(flag) }
})

it('rejects invalid signatures and modified signed content without allocating usage', async () => {
  const a = await owner()
  const event = signed()
  assert.equal((await a.db.add({ ...event, pubkey: a.pubkey })).code, 'invalid')
  assert.equal((await a.db.add({ ...event, content: 'tampered' })).code, 'invalid')
  assert.equal((await a.db.addEvent({ ...event, sig: '0'.repeat(128) })).code, 'invalid')
  assert.equal((await getNostrDbQuotaUsage()).publicCount, 0)
})

it('counts replacements by net bytes and rolls back quota-rejected replacements', async () => {
  const a = await owner()
  const old = signed({ kind: 30023, tags: [['d', 'article']], content: 'old' }, a.secret)
  const large = signed({ kind: 30023, tags: [['d', 'article']], content: 'larger' }, a.secret)
  await limits({ publicBytes: byteSize(old) })
  assert.equal((await a.db.add(old)).stored, true)
  await limits({ publicBytes: byteSize(old) - 1 })
  assert.equal((await a.db.add(large)).quotaCategory, 'public')
  assert.ok(await row(a.raw, old))
  assert.equal(await row(a.raw, large), undefined)
  const smaller = signed({ kind: 30023, tags: [['d', 'article']], content: '' }, a.secret)
  await limits({ publicBytes: 1 })
  assert.equal((await a.db.add(smaller)).code, 'replaced')
  assert.equal((await getNostrDbQuotaUsage()).publicBytes, byteSize(smaller))
})

it('indexes arbitrary one-character references, promotes targets and demotes after the last removal', async () => {
  const a = await owner()
  const target = signed({ kind: 30023, tags: [['d', 'x:y']] })
  const address = `30023:${target.pubkey.toUpperCase()}:x:y`
  const ref1 = signed({ tags: [['q', target.id], ['q', target.id]] }, a.secret)
  const ref2 = signed({ tags: [['X', address]] }, a.secret)
  assert.equal(ownerReferenceKeys(ref1, a.pubkey).length, 1)
  assert.equal((await a.db.add(ref1)).stored, true)
  assert.equal((await a.db.add(target)).stored, true)
  assert.equal(await access(a.raw, target), undefined)
  await a.db.add(ref2)
  await a.db.add(signed({ kind: 5, tags: [['e', ref1.id]] }, a.secret))
  assert.equal(await access(a.raw, target), undefined)
  await a.db.add(signed({ kind: 5, tags: [['e', ref2.id]] }, a.secret))
  assert.ok(await access(a.raw, target))
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 1)
})

it('does not preserve targets through third-party or multi-character tags', async () => {
  const a = await owner()
  const target = signed()
  await a.db.add(signed({ tags: [['reference', target.id]] }, a.secret))
  await a.db.add(signed({ tags: [['x', target.id]] }))
  await a.db.add(target)
  assert.ok(await access(a.raw, target))
})

it('protects app-owned targets from uninstall and unclaimed cleanup but honors replacement and expiration', async () => {
  const a = await owner()
  const target = signed({ kind: 30078, tags: [['d', 'settings']] })
  const newer = signed({ kind: 30078, tags: [['d', 'settings'], ['expiration', '9999999999']] })
  const reference = signed({ tags: [['q', `30078:${target.pubkey}:settings`]] }, a.secret)
  await a.db.add(target, { appId: APP })
  await a.db.add(reference)
  assert.equal(await a.db.deleteEventsByApp(APP), 0)
  assert.ok(await row(a.raw, target))
  assert.equal(await a.db.purgeUnclaimedAppData({ graceMs: 0, now: 4000000000 }), 0)
  assert.equal((await a.db.add(newer)).code, 'replaced')
  assert.equal(await row(a.raw, target), undefined)
  assert.equal(await access(a.raw, newer), undefined)
  const expiring = signed({ kind: 30078, tags: [['d', 'settings'], ['expiration', '4000000000']] })
  await a.db.add(expiring)
  assert.equal(await a.db.purgeExpired({ now: 4000000001 }), 1)
  assert.equal(await row(a.raw, expiring), undefined)
})

it('pools every personal-copy author and context in the private quota without eviction', async () => {
  const a = await owner()
  const obfuscate = async (value, kind, scope) => `${scope}:${value}`
  a.db.personalCopyDecrypt = async event => event.content
  a.db.personalCopyObfuscate = obfuscate
  const copy = async (inner, context) => finalizeEvent(await buildPersonalCopyUnsignedEvent({
    originalEvent: inner, ownerPubkey: a.pubkey, context,
    encrypt: async (kind, value) => value, obfuscate
  }), a.secret)
  const first = await copy(signed(), 'foreign-context')
  const second = await copy(signed({}, a.secret), 'owner-context')
  await limits({ privateBytes: byteSize(first), publicBytes: 0, cacheBytes: 0 })
  assert.equal((await a.db.add(first)).stored, true)
  await limits({ privateBytes: byteSize(first) - 1 })
  assert.equal((await a.db.add(second)).quotaCategory, 'private')
  assert.ok(await row(a.raw, first))
  const usage = await getNostrDbQuotaUsage()
  assert.equal(usage.publicCount, 0)
  assert.equal(usage.privateCount, 1)
  assert.equal(usage.privateBytes, byteSize(first))
  assert.equal(usage.cacheCount, 0)
  let signatures = 0
  const forged = { ...first, tags: [...first.tags, ['o', 'invalid mirror']], sig: '0'.repeat(128) }
  assert.equal((await a.db.add(forged, {
    signEvent: template => {
      signatures++
      return finalizeEvent(template, a.secret)
    }
  })).code, 'invalid')
  assert.equal(signatures, 0, 'verify the original wrapper before normalization can request a new signature')
})

it('updates LRU separately, at most once per minute, and ignores missing/promoted rows', async t => {
  const a = await owner()
  const event = signed()
  await a.db.add(event)
  const before = await row(a.raw, event)
  const initial = (await access(a.raw, event)).lastAccessAt
  t.mock.method(Date, 'now', () => initial + 61000)
  queueCacheAccess(a.pubkey, [event])
  await flushCacheAccess()
  assert.equal((await access(a.raw, event)).lastAccessAt, initial + 61000)
  assert.deepEqual(await row(a.raw, event), before)
  Date.now.mock.mockImplementation(() => initial + 62000)
  queueCacheAccess(a.pubkey, [event])
  await flushCacheAccess()
  assert.equal((await access(a.raw, event)).lastAccessAt, initial + 61000)
  await a.db.add(signed({ tags: [['q', event.id]] }, a.secret))
  queueCacheAccess(a.pubkey, [event])
  await flushCacheAccess()
  assert.equal(await access(a.raw, event), undefined)
})

it('public-limit reduction preserves cache; only cache excess triggers eviction across accounts', async t => {
  const a = await owner()
  const b = await owner()
  const cold = signed({ content: 'x'.repeat(6000) })
  const hot = signed({ content: 'x'.repeat(6000) })
  await a.db.add(cold)
  await b.db.add(hot)
  const latest = (await access(b.raw, hot)).lastAccessAt
  t.mock.method(Date, 'now', () => latest + 61000)
  queueCacheAccess(b.pubkey, [hot])
  await flushCacheAccess()
  await limits({ publicBytes: 0 })
  await maintainNostrDbCache()
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 2)
  await limits({ publicBytes: DEFAULT_NOSTRDB_QUOTAS.publicBytes, cacheBytes: Math.ceil(byteSize(hot) / 0.9) })
  await maintainNostrDbCache()
  assert.equal(await row(a.raw, cold), undefined)
  assert.ok(await row(b.raw, hot))
})

it('aborts event and usage writes together on a late transaction failure', async t => {
  const a = await owner()
  const first = signed()
  await a.db.add(first)
  const originalUsage = await getNostrDbQuotaUsage()
  const original = a.raw.transaction.bind(a.raw)
  const mock = t.mock.method(a.raw, 'transaction', (...args) => {
    const tx = original(...args)
    if (args[1] === 'readwrite' && Array.isArray(args[0]) && args[0].includes('deletions')) {
      const store = tx.objectStore('maintenance')
      const put = store.put.bind(store)
      store.put = value => {
        const req = put(value)
        req.addEventListener('success', () => tx.abort(), { once: true })
        return req
      }
    }
    return tx
  })
  const second = signed()
  assert.equal((await a.db.add(second)).code, 'error')
  mock.mock.restore()
  assert.equal(await row(a.raw, second), undefined)
  assert.equal(await access(a.raw, second), undefined)
  assert.deepEqual(await getNostrDbQuotaUsage(), originalUsage)
})

it('backfills legacy rows and references without verifying old signatures', async () => {
  const secret = new Uint8Array(32).fill(seed++)
  const pubkey = getPublicKey(secret)
  owners.push(pubkey)
  const target = signed()
  const reference = signed({ tags: [['q', target.id]] }, secret)
  const req = indexedDB.open(`${NOSTRDB_PREFIX}${pubkey}`, 2)
  req.onupgradeneeded = () => {
    const store = req.result.createObjectStore('events', { keyPath: 'i' })
    store.put(toStoredRecord(target))
    store.put(toStoredRecord({ ...reference, sig: '0'.repeat(128) }))
    req.result.createObjectStore('deletions', { keyPath: 'ref' })
    req.result.createObjectStore('kindRegistry', { keyPath: 'key' })
    req.result.createObjectStore('maintenance', { keyPath: 'key' })
  }
  ;(await request(req)).close()
  const usage = await getNostrDbQuotaUsage()
  assert.equal(usage.publicCount, 2)
  assert.equal(usage.cacheCount, 0)
  assert.equal((await openNostrDb(pubkey)).version, NOSTRDB_VERSION)
})

it('continues local writes during enumeration failure and retains the last valid totals', async t => {
  const a = await owner()
  const previous = await getNostrDbQuotaUsage()
  const mock = t.mock.method(indexedDB, 'databases', async () => { throw new Error('unavailable enumeration') })
  assert.equal((await a.db.add(signed())).stored, true)
  await assert.rejects(getNostrDbQuotaUsage())
  const { readQuotaState } = await import('#services/idb/nostrdb/quotas.js')
  assert.deepEqual(readQuotaState().totals, previous)
  assert.equal(readQuotaState().maintenance.failed, true)
  mock.mock.restore()
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 1)
})

it('keeps a pending replacement intact when cache growth is disabled, without foreground eviction', async () => {
  const a = await owner()
  const b = await owner()
  const old = signed({ kind: 30023, tags: [['d', 'post']], content: 'x'.repeat(200) })
  const other = signed()
  const larger = signed({ kind: 30023, tags: [['d', 'post']], content: 'x'.repeat(6000) })
  await a.db.add(old)
  await b.db.add(other)
  await limits({ cacheBytes: 0 })
  const result = await a.db.add(larger)
  assert.equal(result.quotaCategory, 'cache')
  assert.ok(await row(a.raw, old))
  assert.equal(await row(a.raw, larger), undefined)
  assert.ok(await row(b.raw, other), 'admission does not perform foreground eviction')
  assert.equal((await getNostrDbQuotaUsage()).cacheBytes, byteSize(old) + byteSize(other))
})

it('admits a deletion that demotes protected events and trims the excess later', async () => {
  const a = await owner()
  const target = signed()
  const ref = signed({ tags: [['x', target.id]] }, a.secret)
  await a.db.add(ref)
  await a.db.add(target)
  await limits({ cacheBytes: 0 })
  assert.equal((await a.db.add(signed({ kind: 5, tags: [['e', ref.id]] }, a.secret))).ok, true)
  assert.ok(await access(a.raw, target))
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 1)
  await maintainNostrDbCache()
  assert.equal(await row(a.raw, target), undefined)
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 0)
})

it('rolls back deletion, tombstones, replacement and both reference transitions', async t => {
  const a = await owner()
  const target = signed({ kind: 30023, tags: [['d', 'target']] })
  await a.db.add(target)
  const snapshot = async () => Object.fromEntries(await Promise.all(['events', 'cacheAccess', 'deletions', 'maintenance'].map(async store => [store,
    await request(a.raw.transaction(store).objectStore(store).getAll())
  ])))
  const abortAdmission = async event => {
    const before = await snapshot()
    const original = a.raw.transaction.bind(a.raw)
    const mocked = t.mock.method(a.raw, 'transaction', (...args) => {
      const tx = original(...args)
      if (args[1] === 'readwrite' && Array.isArray(args[0]) && args[0].includes('deletions')) {
        const store = tx.objectStore('maintenance')
        const put = store.put.bind(store)
        store.put = value => {
          const req = put(value)
          req.addEventListener('success', () => tx.abort(), { once: true })
          return req
        }
      }
      return tx
    })
    assert.equal((await a.db.add(event)).code, 'error')
    mocked.mock.restore()
    assert.deepEqual(await snapshot(), before)
  }
  await abortAdmission(signed({ kind: 30023, tags: [['d', 'target']] }))
  await abortAdmission(signed({ kind: 5, tags: [['e', target.id]] }))
  const ref = signed({ tags: [['q', target.id]] }, a.secret)
  await abortAdmission(ref)
  await a.db.add(ref)
  assert.equal(await access(a.raw, target), undefined)
  await abortAdmission(signed({ kind: 5, tags: [['e', ref.id]] }, a.secret))
})

it('resumes interrupted migration pages in either pass without duplicating counters', async t => {
  for (const phase of ['records', 'classify']) {
    const a = await owner()
    const template = signed()
    const rows = Array.from({ length: 1002 }, (_, i) => toStoredRecord({ ...template, id: (i + 1).toString(16).padStart(64, '0') }))
    const tx = a.raw.transaction(['events', 'maintenance'], 'readwrite')
    const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    for (const row of rows) tx.objectStore('events').put(row)
    tx.objectStore('maintenance').delete('quotaUsage')
    await done
    const original = a.raw.transaction.bind(a.raw)
    const mocked = t.mock.method(a.raw, 'transaction', (...args) => {
      const tx = original(...args)
      if (args[1] === 'readwrite' && args[0].includes('maintenance')) {
        const store = tx.objectStore('maintenance')
        const put = store.put.bind(store)
        store.put = value => {
          const req = put(value)
          if ((phase === 'records' && value.phase === 'classify') || (phase === 'classify' && value.phase === 'ready')) {
            req.addEventListener('success', () => tx.abort(), { once: true })
          }
          return req
        }
      }
      return tx
    })
    await assert.rejects(getNostrDbQuotaUsage())
    mocked.mock.restore()
    assert.equal(await request(a.raw.transaction('cacheAccess').objectStore('cacheAccess').count()), phase === 'classify' ? 1000 : 0)
    const checkpoint = await request(a.raw.transaction('maintenance').objectStore('maintenance').get('quotaUsage'))
    assert.equal(checkpoint.phase, phase)
    assert.ok(checkpoint.after)
    const usage = await getNostrDbQuotaUsage()
    const expected = rows.reduce((sum, row) => sum + byteSize(row.event), 0)
    assert.equal(usage.publicCount, 0)
    assert.equal(usage.cacheCount, 1002)
    assert.equal(usage.publicBytes, 0)
    assert.equal(usage.cacheBytes, expected)
    assert.equal(await deleteNostrDb(a.pubkey), true)
  }
})

it('touches only full app queries and actually delivered subscription events', async t => {
  const a = await owner()
  const first = signed()
  const second = signed()
  await a.db.add(first)
  await a.db.add(second)
  const before = (await access(a.raw, first)).lastAccessAt
  const now = before + 61000
  t.mock.method(Date, 'now', () => now)
  await a.db.query({ ids: [first.id] })
  await a.db.query({ ids: [first.id], ids_only: true }, { appId: APP })
  await a.db.query({ ids: [first.id], search: 'algo:sync' }, { appId: APP })
  await a.db.count({ ids: [first.id] }, { appId: APP })
  await a.db.add(first)
  await maintainNostrDbCache()
  await flushCacheAccess()
  assert.equal((await access(a.raw, first)).lastAccessAt, before)
  await a.db.query({ ids: [first.id] }, { appId: APP })
  await flushCacheAccess()
  assert.equal((await access(a.raw, first)).lastAccessAt, now)

  const subscription = a.db.subscribe({}, { appId: APP, initial: true })
  const delivered = (await subscription.next()).value.event
  await subscription.return()
  await flushCacheAccess()
  assert.equal((await access(a.raw, delivered)).lastAccessAt, now)
  // A second replay stopped before consuming next() must not touch anything.
  const untouched = a.db.subscribe({}, { appId: APP, initial: true })
  await untouched.return()
})

it('bounds and batches the access queue, dropping its oldest pending entry', async t => {
  const a = await owner()
  const event = signed()
  await a.db.add(event)
  const before = (await access(a.raw, event)).lastAccessAt
  t.mock.method(Date, 'now', () => before + 61000)
  const calls = []
  const realSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { if (ms === 0) return realSetTimeout(fn, ms); calls.push({ fn, ms }); return { unref () {} } })
  t.mock.method(globalThis, 'clearTimeout', () => {})
  queueCacheAccess(a.pubkey, [event])
  // Other IDs need not be stored: draining their touches must never create rows.
  queueCacheAccess(a.pubkey, Array.from({ length: 2048 }, (_, i) => ({ ...event, id: (i + 1).toString(16).padStart(64, '0') })))
  assert.equal(calls[0].ms, 250)
  let gets = 0
  const transaction = a.raw.transaction.bind(a.raw)
  t.mock.method(a.raw, 'transaction', (...args) => {
    const tx = transaction(...args)
    if (args[0] === 'cacheAccess' && args[1] === 'readwrite') {
      const store = tx.objectStore('cacheAccess')
      const get = store.get.bind(store)
      store.get = key => { gets++; return get(key) }
    }
    return tx
  })
  await flushCacheAccess()
  assert.equal(gets, 100)
  for (let i = 0; i < 20; i++) await flushCacheAccess()
  assert.equal(gets, 2048)
  assert.equal((await access(a.raw, event)).lastAccessAt, before)
  assert.equal(await request(a.raw.transaction('cacheAccess').objectStore('cacheAccess').count()), 1)
})

it('discards an invalid CRDT signature and retains the valid input fallback', async () => {
  const a = await owner()
  const event = signed({ kind: 30023, tags: [['d', 'post']] }, a.secret)
  let invalid
  const result = await a.db.add(event, {
    signEvent: template => {
      invalid = { ...finalizeEvent(structuredClone(template), a.secret), sig: '0'.repeat(128) }
      return invalid
    }
  })
  assert.ok(invalid)
  assert.equal(result.ok, true)
  assert.deepEqual((await row(a.raw, event)).event, event)
  assert.equal(await row(a.raw, invalid), undefined)
  assert.equal((await getNostrDbQuotaUsage()).publicCount, 1)
})

it('defers bridge touches until delivery is acknowledged, including initial replay', async t => {
  const a = await owner()
  const first = signed()
  const second = signed()
  await a.db.add(first)
  await a.db.add(second)
  const before = (await access(a.raw, first)).lastAccessAt
  let now = before + 61000
  t.mock.method(Date, 'now', () => now)
  const options = { appId: APP, deferCacheAccess: true }
  const result = await a.db.query({}, options)
  await flushCacheAccess()
  assert.equal((await access(a.raw, first)).lastAccessAt, before)
  a.db.recordCacheAccess(result, {}, options)
  await flushCacheAccess()
  assert.equal((await access(a.raw, first)).lastAccessAt, now)
  now += 61000
  const subscription = a.db.subscribe({}, { ...options, initial: true })
  const delivered = (await subscription.next()).value
  await flushCacheAccess()
  assert.equal((await access(a.raw, delivered.event)).lastAccessAt, now - 61000)
  a.db.recordCacheAccess(delivered, {}, options)
  await subscription.return()
  await flushCacheAccess()
  assert.equal((await access(a.raw, delivered.event)).lastAccessAt, now)
  const other = delivered.event.id === first.id ? second : first
  assert.equal((await access(a.raw, other)).lastAccessAt, now - 61000)
})

it('derives cache counts exactly from byte overrides, including old settings and zero', async () => {
  for (const [mib, count] of [[0, 0], [64, 25000], [128, 50000], [256, 100000]]) {
    assert.equal(cacheEventLimit(mib * 1048576), count)
    await limits({ cacheBytes: mib * 1048576 })
    assert.equal(getNostrDbQuotaLimits().cacheCount, count)
  }
  const max = Number.MAX_SAFE_INTEGER
  assert.equal(cacheEventLimit(max), Number(BigInt(max) * 50000n / 134217728n))
  settings.set('44billion:nostrdb-quotas:v1', JSON.stringify({ cacheBytes: 67108864, cacheCount: 999 }))
  assert.equal(getNostrDbQuotaLimits().cacheCount, 25000)
  await limits({ publicBytes: 1 })
  assert.equal(Object.hasOwn(JSON.parse(settings.get('44billion:nostrdb-quotas:v1')), 'cacheCount'), false)
})

it('detects proportional count excess asynchronously and cleans both cache limits after reduction', async () => {
  const a = await owner()
  const first = signed()
  const second = signed()
  await limits({ cacheBytes: 3000 }) // one event, though both fit in bytes
  await a.db.add(first)
  assert.equal((await a.db.add(second)).stored, true)
  assert.ok(await row(a.raw, first))
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 2)
  assert.equal((await a.db.add(signed())).quotaCategory, 'cache')
  await limits({ cacheBytes: 0 })
  await maintainNostrDbCache()
  const usage = await getNostrDbQuotaUsage()
  assert.equal(usage.cacheBytes, 0)
  assert.equal(usage.cacheCount, 0)
})

it('removes exact IDs and current coordinates atomically, normalizing and deduplicating targets', async () => {
  const a = await owner()
  const b = await owner()
  const first = signed({ kind: 30023, tags: [['d', 'part:two']] })
  const newer = signed({ kind: 30023, tags: [['d', 'part:two']] })
  await a.db.add(first)
  await a.db.add(newer)
  await b.db.add(newer)
  assert.equal((await a.db.remove([['e', first.id]])).code, 'noop')
  const result = await a.db.remove([
    ['e', newer.id.toUpperCase()], ['e', newer.id],
    ['a', `030023:${newer.pubkey.toUpperCase()}:part:two`], ['e', '0'.repeat(64)]
  ])
  assert.deepEqual(result, { ok: true, code: 'deleted', message: 'Events were removed locally.', deleted: 1, removed: [{ id: newer.id, targets: [['e', newer.id], ['a', `30023:${newer.pubkey}:part:two`]] }] })
  assert.equal(await row(a.raw, newer), undefined)
  assert.equal(await access(a.raw, newer), undefined)
  assert.ok(await row(b.raw, newer))
  assert.equal((await a.db.add(newer)).stored, true, 'no tombstone is created')
})

it('validates all local targets before deleting or checking access', async () => {
  const a = await owner()
  const event = signed()
  await a.db.add(event)
  for (const invalid of [[], null, [['x', event.id]], [['e', event.id, 'extra']], [['a', `65536:${event.pubkey}:`]], Array(101).fill(['e', event.id]), [['e', event.id], ['e', 'bad']]]) {
    const result = await a.db.remove(invalid, { assertAccess () { assert.fail('invalid input must be rejected first') } })
    assert.equal(result.code, 'invalid')
    assert.equal(result.deleted, 0)
    assert.ok(await row(a.raw, event))
  }
  assert.equal((await a.db.remove(Array(100).fill(['e', event.id]))).deleted, 1)
})

it('allows local removal above quotas, demotes referenced targets and removes protected/shared records', async () => {
  const a = await owner()
  const target = signed()
  await a.db.add(target, { appId: APP })
  const ref = signed({ tags: [['x', target.id]] }, a.secret)
  await a.db.add(ref)
  assert.equal(await access(a.raw, target), undefined)
  await limits({ publicBytes: 0, cacheBytes: 0 })
  assert.equal((await a.db.remove([['e', ref.id]])).deleted, 1)
  assert.ok(await access(a.raw, target))
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 1)
  assert.equal((await a.db.remove([['e', target.id]])).deleted, 1)
  assert.equal((await getNostrDbQuotaUsage()).publicBytes, 0)
})

it('removes deletion-request contributions and permits the deleted event to return', async () => {
  const a = await owner()
  const event = signed()
  await a.db.add(event)
  const deletion = signed({ kind: 5, tags: [['e', event.id]] })
  await a.db.add(deletion)
  assert.equal(await row(a.raw, event), undefined)
  assert.equal((await a.db.remove([['e', deletion.id]])).deleted, 1)
  assert.equal((await a.db.add(event)).stored, true)
})

it('rolls back every local removal and reference transition if its transaction aborts', async t => {
  const a = await owner()
  const target = signed()
  const ref = signed({ tags: [['x', target.id]] }, a.secret)
  await a.db.add(target)
  await a.db.add(ref)
  const usage = await getNostrDbQuotaUsage()
  const original = a.raw.transaction.bind(a.raw)
  const mock = t.mock.method(a.raw, 'transaction', (...args) => {
    const tx = original(...args)
    if (args[1] === 'readwrite' && Array.isArray(args[0]) && args[0].includes('deletions')) {
      const store = tx.objectStore('maintenance')
      const put = store.put.bind(store)
      store.put = value => {
        const req = put(value)
        req.addEventListener('success', () => tx.abort(), { once: true })
        return req
      }
    }
    return tx
  })
  assert.equal((await a.db.remove([['e', ref.id], ['e', target.id]])).code, 'error')
  mock.mock.restore()
  assert.ok(await row(a.raw, ref))
  assert.ok(await row(a.raw, target))
  assert.equal(await access(a.raw, target), undefined)
  assert.deepEqual(await getNostrDbQuotaUsage(), usage)
})

it('rechecks access under the lock and resolves an address only in the deletion transaction', async () => {
  const a = await owner()
  const first = signed({ kind: 30023, tags: [['d', '']] })
  const newer = signed({ kind: 30023, tags: [['d', '']] })
  await a.db.add(first)
  const { runNostrDbMethod } = await import('#helpers/window-message/browser/nostrdb.js')
  const permission = Promise.withResolvers()
  const requested = Promise.withResolvers()
  const deletion = runNostrDbMethod({
    db: a.db, method: 'remove', params: [[['a', `30023:${first.pubkey}:`]]],
    requestPermission: async () => { requested.resolve(); await permission.promise }
  })
  await requested.promise
  assert.equal((await a.db.add(newer)).stored, true)
  permission.resolve()
  assert.equal((await deletion).deleted, 1)
  assert.equal(await row(a.raw, newer), undefined)
  await a.db.add(newer)
  let checks = 0
  await assert.rejects(a.db.remove([['e', newer.id]], {
    assertAccess () {
      if (++checks > 1) throw Object.assign(new Error('revoked'), { code: 'PUBKEY_NOT_IN_PERSONA' })
    }
  }), { code: 'PUBKEY_NOT_IN_PERSONA' })
  assert.ok(await row(a.raw, newer))
})

it('removes personal copies by wrapper ID without needing a signer or decryptor', async () => {
  const a = await owner()
  a.db.personalCopyDecrypt = async event => event.content
  a.db.personalCopyObfuscate = async (value, kind, scope) => `${scope}:${value}`
  const inner = signed()
  const wrapper = finalizeEvent(await buildPersonalCopyUnsignedEvent({
    originalEvent: inner, ownerPubkey: a.pubkey, context: 'local-removal',
    encrypt: async (kind, value) => value, obfuscate: a.db.personalCopyObfuscate
  }), a.secret)
  assert.equal((await a.db.add(wrapper)).stored, true)
  a.db.personalCopyDecrypt = () => assert.fail('must not decrypt')
  assert.equal((await a.db.remove([['e', inner.id]])).code, 'noop')
  await limits({ privateBytes: 0 })
  assert.equal((await a.db.remove([['e', wrapper.id]])).deleted, 1)
  assert.equal((await getNostrDbQuotaUsage()).privateBytes, 0)
})

async function setAccessTimes (raw, entries) {
  const tx = raw.transaction('cacheAccess', 'readwrite')
  const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
  for (const [event, time] of entries) tx.objectStore('cacheAccess').put({ i: eventIdIndexKey(event.id), lastAccessAt: time })
  await done
}

it('keeps public and cache quotas exclusive and independent in both directions', async () => {
  const a = await owner()
  const own = signed({}, a.secret)
  const cached = signed()
  await limits({ publicBytes: 0 })
  assert.equal((await a.db.add(cached)).stored, true)
  assert.equal((await a.db.add(own)).quotaCategory, 'public')
  let usage = await getNostrDbQuotaUsage()
  assert.equal(usage.publicBytes, 0)
  assert.equal(usage.publicCount, 0)
  assert.equal(usage.cacheBytes, byteSize(cached))
  await limits({ publicBytes: byteSize(own), cacheBytes: 0 })
  assert.equal((await a.db.add(own)).stored, true)
  await maintainNostrDbCache()
  usage = await getNostrDbQuotaUsage()
  assert.equal(usage.publicBytes, byteSize(own))
  assert.equal(usage.publicCount, 1)
  assert.equal(usage.cacheBytes, 0)
  assert.equal(usage.cacheCount, 0)
  assert.ok(await row(a.raw, own))
})

it('preserves every newly protected target even when their promotion exceeds the public quota', async () => {
  const a = await owner()
  const b = await owner()
  const otherOwner = signed({}, b.secret)
  await b.db.add(otherOwner)
  const huge = signed({ content: 'x'.repeat(6000) })
  const tied = ['A', 'B'].map(d => signed({ kind: 30023, tags: [['d', d]], content: 'x'.repeat(2000) }))
  tied.sort((a, b) => indexedDB.cmp(eventIdIndexKey(a.id), eventIdIndexKey(b.id)))
  const small = signed()
  for (const event of [huge, ...tied, small]) await a.db.add(event)
  await setAccessTimes(a.raw, [[huge, 500], [tied[0], 400], [tied[1], 400], [small, 300]])
  const ref = signed({
    tags: [
      ['q', small.id], ['x', tied[1].id], ['e', huge.id], ['e', tied[0].id],
      ['a', `30023:${tied[0].pubkey}:${tied[0].tags[0][1]}`], ['e', tied[0].id]
    ]
  }, a.secret)
  const budget = byteSize(otherOwner) + byteSize(ref) + byteSize(tied[0]) + byteSize(small)
  await limits({ publicBytes: budget })
  assert.equal((await a.db.add(ref)).stored, true)
  assert.ok(await row(a.raw, ref))
  for (const event of [huge, ...tied, small]) {
    assert.ok(await row(a.raw, event))
    assert.equal(await access(a.raw, event), undefined)
  }
  const usage = await getNostrDbQuotaUsage()
  assert.equal(usage.publicCount, 6)
  assert.ok(usage.publicBytes > budget)
  assert.equal(usage.cacheCount, 0)
  assert.equal((await a.db.add(signed({}, a.secret))).quotaCategory, 'public')
  await a.db.remove([['e', ref.id]])
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 4)
})

it('keeps newly protected cache when a referrer uses the remaining public room', async () => {
  const a = await owner()
  const protectedTarget = signed()
  const previousRef = signed({ tags: [['e', protectedTarget.id]] }, a.secret)
  await a.db.add(previousRef)
  await a.db.add(protectedTarget)
  const cached = signed()
  await a.db.add(cached)
  const ref = signed({ tags: [['x', cached.id], ['q', protectedTarget.id]] }, a.secret)
  const usage = await getNostrDbQuotaUsage()
  await limits({ publicBytes: usage.publicBytes + byteSize(ref) })
  assert.equal((await a.db.add(ref)).stored, true)
  assert.ok(await row(a.raw, protectedTarget))
  assert.ok(await row(a.raw, previousRef))
  assert.ok(await row(a.raw, cached))
  assert.equal(await access(a.raw, cached), undefined)
  assert.equal((await getNostrDbQuotaUsage()).publicBytes, usage.publicBytes + byteSize(ref) + byteSize(cached))
})

it('refuses new public growth with a zero limit without deleting cache', async () => {
  const a = await owner()
  const target = signed()
  await a.db.add(target)
  const ref = signed({ tags: [['x', target.id]] }, a.secret)
  const before = await getNostrDbQuotaUsage()
  await limits({ publicBytes: 0 })
  assert.equal((await a.db.add(ref)).quotaCategory, 'public')
  assert.equal(await row(a.raw, ref), undefined)
  assert.ok(await row(a.raw, target))
  assert.ok(await access(a.raw, target))
  assert.deepEqual(await getNostrDbQuotaUsage(), before)
})

it('allows reference transfers during a shrinking replacement with a zero public limit', async () => {
  const a = await owner()
  const old = signed({ kind: 30023, tags: [['d', 'ref']], content: 'x'.repeat(5000) }, a.secret)
  const target = signed({ content: 'x'.repeat(2000) })
  await a.db.add(old)
  await a.db.add(target)
  const next = signed({ kind: 30023, tags: [['d', 'ref'], ['x', target.id]] }, a.secret)
  await limits({ publicBytes: 0 })
  assert.equal((await a.db.add(next)).code, 'replaced')
  assert.ok(await row(a.raw, target))
  assert.equal(await access(a.raw, target), undefined)
  const usage = await getNostrDbQuotaUsage()
  assert.equal(usage.publicBytes, byteSize(next) + byteSize(target))
  assert.equal(usage.cacheBytes, 0)
  assert.ok(usage.publicBytes < byteSize(old))
  assert.equal((await a.db.add(next)).code, 'duplicate')
  assert.deepEqual(await getNostrDbQuotaUsage(), usage)
})

it('accounts for demotions before promotions independent of reference iteration order', async () => {
  const a = await owner()
  const oldTarget = signed({ content: 'x'.repeat(2000) })
  const newTarget = signed({ content: 'x'.repeat(2000) })
  const old = signed({ kind: 30023, tags: [['d', 'ref'], ['e', oldTarget.id]] }, a.secret)
  const next = signed({ kind: 30023, tags: [['d', 'ref'], ['e', newTarget.id]] }, a.secret)
  await a.db.add(old)
  await a.db.add(oldTarget)
  await a.db.add(newTarget)
  await limits({ publicBytes: byteSize(next) + byteSize(newTarget), cacheBytes: 0 })
  assert.equal((await a.db.add(next)).code, 'replaced')
  assert.ok(await access(a.raw, oldTarget))
  assert.equal(await access(a.raw, newTarget), undefined)
  const usage = await getNostrDbQuotaUsage()
  assert.equal(usage.publicBytes, byteSize(next) + byteSize(newTarget))
  assert.equal(usage.cacheBytes, byteSize(oldTarget))
  await maintainNostrDbCache()
  assert.equal(await row(a.raw, oldTarget), undefined)
  assert.ok(await row(a.raw, newTarget))
})

it('rolls back the owner replacement, promotions and access times together', async t => {
  const a = await owner()
  const old = signed({ kind: 30023, tags: [['d', 'ref']] }, a.secret)
  const hot = signed()
  const cold = signed()
  for (const event of [old, hot, cold]) await a.db.add(event)
  await setAccessTimes(a.raw, [[hot, 300], [cold, 200]])
  const ref = signed({ kind: 30023, tags: [['d', 'ref'], ['e', hot.id], ['e', cold.id]] }, a.secret)
  await limits({ publicBytes: byteSize(ref) + byteSize(hot) })
  const usage = await getNostrDbQuotaUsage()
  const original = a.raw.transaction.bind(a.raw)
  const mock = t.mock.method(a.raw, 'transaction', (...args) => {
    const tx = original(...args)
    if (args[1] === 'readwrite' && Array.isArray(args[0]) && args[0].includes('deletions')) {
      const store = tx.objectStore('maintenance')
      const put = store.put.bind(store)
      store.put = value => {
        const req = put(value)
        req.addEventListener('success', () => tx.abort(), { once: true })
        return req
      }
    }
    return tx
  })
  assert.equal((await a.db.add(ref)).code, 'error')
  mock.mock.restore()
  assert.equal(await row(a.raw, ref), undefined)
  for (const event of [old, hot, cold]) assert.ok(await row(a.raw, event))
  assert.equal((await access(a.raw, hot)).lastAccessAt, 300)
  assert.equal((await access(a.raw, cold)).lastAccessAt, 200)
  assert.deepEqual(await getNostrDbQuotaUsage(), usage)
})

it('charges personal referrers privately while promoting their external references publicly', async () => {
  const a = await owner()
  const target = signed()
  await a.db.add(target)
  a.db.personalCopyDecrypt = async event => event.content
  a.db.personalCopyObfuscate = async (value, kind, scope) => `${scope}:${value}`
  const unsigned = await buildPersonalCopyUnsignedEvent({
    originalEvent: signed(), ownerPubkey: a.pubkey, context: 'refs',
    encrypt: async (kind, value) => value, obfuscate: a.db.personalCopyObfuscate
  })
  const wrapper = finalizeEvent({ ...unsigned, tags: [...unsigned.tags, ['x', target.id]] }, a.secret)
  await limits({ publicBytes: 0, privateBytes: byteSize(wrapper) })
  assert.equal((await a.db.add(wrapper)).stored, true)
  assert.ok(await row(a.raw, target))
  assert.equal(await access(a.raw, target), undefined)
  const usage = await getNostrDbQuotaUsage()
  assert.equal(usage.privateBytes, byteSize(wrapper))
  assert.equal(usage.publicBytes, byteSize(target))
  assert.equal(usage.cacheBytes, 0)
})

it('preserves deletion contributions when a cached kind 5 is promoted above quota', async () => {
  const a = await owner()
  const target = signed()
  const deletion = signed({ kind: 5, tags: [['e', target.id]] })
  await a.db.add(target)
  await a.db.add(deletion)
  assert.equal(await row(a.raw, target), undefined)
  assert.ok(await access(a.raw, deletion))
  const ref = signed({ tags: [['x', deletion.id]] }, a.secret)
  await limits({ publicBytes: byteSize(ref) })
  assert.equal((await a.db.add(ref)).stored, true)
  assert.ok(await row(a.raw, deletion))
  assert.equal(await request(a.raw.transaction('deletions').objectStore('deletions').count()), 1)
  assert.equal((await a.db.add(target)).code, 'blocked')
  assert.equal((await getNostrDbQuotaUsage()).publicBytes, byteSize(ref) + byteSize(deletion))
  assert.equal((await getNostrDbQuotaUsage()).cacheBytes, 0)
})

it('does not discard newly arriving referenced events or already preserved versions to fit admission', async () => {
  const a = await owner()
  const old = signed({ kind: 30023, tags: [['d', 'protected']] })
  const newer = signed({ kind: 30023, tags: [['d', 'protected']], content: 'larger' })
  const ref = signed({ tags: [['a', `30023:${old.pubkey}:protected`]] }, a.secret)
  await a.db.add(ref)
  await limits({ publicBytes: 0 })
  assert.equal((await a.db.add(old)).quotaCategory, 'public')
  assert.equal(await row(a.raw, old), undefined)
  await limits({ publicBytes: byteSize(ref) + byteSize(old) })
  assert.equal((await a.db.add(old)).stored, true)
  const before = await getNostrDbQuotaUsage()
  await limits({ publicBytes: before.publicBytes - 1 })
  assert.equal((await a.db.add(newer)).quotaCategory, 'public')
  assert.ok(await row(a.raw, old))
  assert.equal(await row(a.raw, newer), undefined)
  assert.deepEqual(await getNostrDbQuotaUsage(), before)
})

function localCopyFixture (account) {
  const calls = { encrypt: 0, decrypt: 0, obfuscate: 0 }
  const encoder = new TextEncoder()
  const encrypt = async (kind, plaintext) => {
    calls.encrypt++
    return encryptBytes(account.secret, account.pubkey, kind, new Uint8Array(), encoder.encode(plaintext))
  }
  const obfuscate = async (value, kind, scope) => {
    calls.obfuscate++
    return `${kind}:${scope}:${value}`
  }
  const signEvent = async template => {
    const contentKey = new Uint8Array(32).fill(7)
    const pubkey = getPublicKey(contentKey)
    const proofless = { ...template, tags: template.tags.map(tag => tag[0] === 'imkc' ? ['imkc', pubkey] : tag) }
    const proof = finalizeEvent(proofless, contentKey)
    return finalizeEvent({
      ...template,
      tags: template.tags.map(tag => tag[0] === 'imkc' ? ['imkc', pubkey, proof.sig] : tag)
    }, account.secret)
  }
  account.db.personalCopyDecrypt = async event => {
    calls.decrypt++
    const kind = Number(event.tags.find(tag => tag[0] === 'k')[1])
    return new TextDecoder().decode(decryptBytes(account.secret, account.pubkey, kind, new Uint8Array(), event.content))
  }
  account.db.personalCopyObfuscate = obfuscate
  return { calls, encrypt, obfuscate, signEvent, ownerPubkey: account.pubkey }
}

it('returns unchanged public duplicates without requesting the occupied quota lock or writing metadata', async t => {
  const a = await owner()
  const event = signed({ kind: 0 }, a.secret)
  await a.db.add(event)
  const before = await row(a.raw, event)
  const usage = await getNostrDbQuotaUsage()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const holding = withNostrDbQuotaLock(async () => { entered.resolve(); await release.promise })
  await entered.promise
  const original = a.raw.transaction.bind(a.raw)
  let writes = 0
  const spy = t.mock.method(a.raw, 'transaction', (...args) => { if (args[1] === 'readwrite') writes++; return original(...args) })
  let timeout
  try {
    const result = await Promise.race([
      a.db.add(event),
      new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('duplicate waited for quota lock')), 2000) })
    ])
    assert.equal(result.code, 'duplicate')
    assert.equal(result.stored, false)
    assert.equal(writes, 0)
  } finally { clearTimeout(timeout); release.resolve(); await holding; spy.mock.restore() }
  assert.deepEqual(await row(a.raw, event), before)
  assert.deepEqual(await getNostrDbQuotaUsage(), usage)
})

it('rechecks app-reference changes under admission and then permits readonly duplicates', async () => {
  const a = await owner()
  const event = signed({ kind: 40000 })
  await a.db.add(event)
  assert.equal((await a.db.add(event, { appId: APP })).stored, true)
  assert.ok((await row(a.raw, event)).ap?.length)
  assert.equal((await a.db.add(event, { appId: APP })).stored, false)
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 1)
})

it('does not bypass legacy quota reconstruction when a duplicate exists', async () => {
  const a = await owner()
  const event = signed({}, a.secret)
  await a.db.add(event)
  const { initialQuotaUsage } = await import('#services/idb/nostrdb/quotas.js')
  await request(a.raw.transaction('maintenance', 'readwrite').objectStore('maintenance').put(initialQuotaUsage()))
  assert.equal((await a.db.add(event)).code, 'duplicate')
  const usage = await request(a.raw.transaction('maintenance').objectStore('maintenance').get('quotaUsage'))
  assert.equal(usage.phase, 'ready')
  assert.equal(usage.publicCount, 1)
})

for (const change of ['readonly', 'replacement']) {
  it(`rejects a duplicate result when ${change} invalidates its read transaction`, async t => {
    const a = await owner()
    const event = signed({ kind: 0 }, a.secret)
    await a.db.add(event)
    const flag = `session_accountByUserPk_${base16ToBase62(a.pubkey, { mode: 'integer', minLength: 43 })}_isReadOnly`
    const original = a.raw.transaction.bind(a.raw)
    let changed = false
    t.mock.method(a.raw, 'transaction', (...args) => {
      const tx = original(...args)
      if (!changed && args[1] === 'readonly' && args[0].includes('events')) {
        tx.addEventListener('complete', () => {
          changed = true
          if (change === 'readonly') settings.set(flag, 'true')
          else a.raw.onversionchange()
        }, { once: true })
      }
      return tx
    })
    try { await assert.rejects(a.db.add(event), { code: change === 'readonly' ? 'READ_ONLY_ACCOUNT' : 'NOSTRDB_RESET' }) } finally { settings.delete(flag) }
    assert.equal(changed, true)
  })
}

it('resolves ordinary personal-copy provenance once inside each transaction and serializes competing copies', async t => {
  const a = await owner()
  const fixture = localCopyFixture(a)
  const originalEvent = { kind: 9, created_at: 123, tags: [], content: 'same identity' }
  const copies = await Promise.all(Array.from({ length: 2 }, () => createLocalPersonalCopy({ ...fixture, originalEvent, context: 'self' })))
  const prepare = a.db.preparePersonalCopyProvenance.bind(a.db)
  let calls = 0
  t.mock.method(a.db, 'preparePersonalCopyProvenance', (...args) => {
    calls++
    assert.equal(args[2].tx.mode, 'readwrite')
    return prepare(...args)
  })
  const results = await Promise.all(copies.map(copy => a.db.add(copy)))
  assert.ok(results.every(result => result.ok))
  assert.equal(calls, 2)
  const { results: stored } = await a.db.query({ kinds: [1006] })
  assert.equal(stored.length, 1)
  assert.ok(copies.some(copy => copy.id === stored[0].id))
  assert.equal((await getNostrDbQuotaUsage()).privateCount, 1)
})

it('executes the actual query after an empty planning probe, observing a queued insertion', async t => {
  const development = globalThis.IS_DEVELOPMENT
  globalThis.IS_DEVELOPMENT = true
  t.after(() => { if (development === undefined) delete globalThis.IS_DEVELOPMENT; else globalThis.IS_DEVELOPMENT = development })
  const a = await owner()
  const event = signed({ tags: [['k', 'new'], ['c', 'conversation']] })
  let inserted
  const result = await a.db.query({ '#k': ['new'], '#c': ['conversation'] }, {
    onTiming: measure => {
      if (measure.stage !== 'query-planning' || inserted) return
      assert.equal(measure.keysExamined, 0)
      // Queue a real writer before the result cursor. This isolates planning
      // estimates from the later read; quota accounting is tested separately.
      inserted = request(a.raw.transaction('events', 'readwrite').objectStore('events').put(toStoredRecord(event)))
    }
  })
  assert.ok(inserted)
  await inserted
  assert.deepEqual(result.results.map(event => event.id), [event.id])
})

it('matches reference results for selective OR/AND, search, count, expiration and combined filters', async t => {
  const a = await owner()
  const { ParsedFilter } = await import('#services/idb/nostrdb/index.js')
  let now = 100000
  t.mock.method(Date, 'now', () => now)
  const events = Array.from({ length: 12 }, (_, i) => signed({
    created_at: 10 + i, content: i % 2 ? 'needle' : 'hay',
    tags: [['t', 'shared'], ['o', `id-${i}`], ...(i % 2 ? [['t', 'odd']] : []), ...(i === 5 ? [['expiration', '110']] : [])]
  }))
  for (const event of events) assert.equal((await a.db.add(event)).ok, true)
  now = 120000
  for (const raw of [
    { '#t': ['shared'], '#o': ['id-3', 'id-5', 'id-7'] },
    { '#t': ['shared'], '&o': ['id-7'] },
    { '&t': ['shared', 'odd'], limit: 3 },
    { '#t': ['shared'], '#o': ['id-3', 'id-7'], '!ids': [events[3].id], ids_only: true },
    { '#t': ['shared'], '&t': ['odd'], search: 'needle' },
    { '#t': ['shared'], '#o': ['id-3', 'id-7'], search: 'sort:asc' },
    [{ '#t': ['odd'], '#o': ['id-3'] }, { '#t': ['shared'], '#o': ['id-2', 'id-7'] }]
  ]) {
    const filters = (Array.isArray(raw) ? raw : [raw]).map(value => new ParsedFilter(value))
    const first = Array.isArray(raw) ? raw[0] : raw
    const expected = events.filter(event => event !== events[5] && filters.some(filter => filter.matches(event)))
      .sort((a, b) => first.search === 'sort:asc' ? a.created_at - b.created_at : b.created_at - a.created_at)
      .slice(0, first.limit ?? Infinity)
    const actual = await a.db.query(raw)
    assert.deepEqual(actual.results.map(value => typeof value === 'string' ? value : value.id), expected.map(event => event.id))
    assert.equal(await a.db.count(raw), expected.length)
  }
})

it('local personal-copy ingest avoids decryption and repeated obfuscation with real signatures and ciphertext', async () => {
  const a = await owner()
  const fixture = localCopyFixture(a)
  const tagCount = 24
  const original = {
    kind: 9, created_at: 123, content: 'ação 😀 ?',
    tags: Array.from({ length: tagCount }, (_, i) => ['t', String(i)])
  }
  const result = await runNostrDbMethod({
    db: a.db, method: 'addPersonalCopy', params: [original, { context: 'self' }], appId: APP,
    signEvent: fixture.signEvent, personalCopyEncrypt: fixture.encrypt,
    personalCopyObfuscate: fixture.obfuscate, requestPermission: async () => {}
  })
  assert.equal(result.result.stored, true)
  assert.deepEqual(fixture.calls, { encrypt: 1, decrypt: 0, obfuscate: tagCount + 3 })
  assert.ok(await row(a.raw, result.event))
  assert.equal((await getNostrDbQuotaUsage()).privateBytes, byteSize(result.event))

  // The preparation is consumed: even the very same object must be inspected
  // on a later ordinary add. A serialized app option cannot bypass validation.
  const before = fixture.calls.obfuscate
  assert.equal((await a.db.add(result.event, { alreadyValidated: true, personalCopy: { inner: original } })).code, 'duplicate')
  assert.equal(fixture.calls.decrypt, 1)
  assert.equal(fixture.calls.obfuscate - before, tagCount + 2)
})

it('local preparation snapshots the inner event before awaiting encryption', async () => {
  const a = await owner()
  const fixture = localCopyFixture(a)
  const original = { kind: 9, created_at: 123, content: 'before', tags: [['t', 'before']] }
  const event = await createLocalPersonalCopy({
    ...fixture, originalEvent: original,
    encrypt: async (...args) => {
      original.content = 'after'
      original.tags[0][1] = 'after'
      return fixture.encrypt(...args)
    }
  })
  assert.equal((await a.db.add(event)).stored, true)
  assert.equal(fixture.calls.decrypt, 0)
  assert.ok(event.tags.some(tag => tag[1] === '1006:#t:before'))
  assert.equal(JSON.parse(await a.db.personalCopyDecrypt(event)).content, 'before')
})

it('local preparation rejects unexpected signed fields, tag rewrites and template mutation', async () => {
  const a = await owner()
  const fixture = localCopyFixture(a)
  const originalEvent = { kind: 9, created_at: 123, content: 'before', tags: [] }
  for (const change of [
    template => ({ ...template, content: 'different ciphertext' }),
    template => ({ ...template, created_at: 124 }),
    template => ({ ...template, kind: 1 }),
    template => ({ ...template, tags: [...template.tags, ['x', 'extra']] }),
    template => ({ ...template, tags: template.tags.map(tag => tag[0] === 'imkc' ? ['imkc', 'invalid'] : tag) }),
    template => { template.content = 'mutated'; return template }
  ]) {
    await assert.rejects(createLocalPersonalCopy({
      ...fixture, originalEvent,
      signEvent: template => finalizeEvent(change(template), a.secret)
    }), /INVALID_PERSONAL_COPY_SIGNATURE_RESULT/)
  }
  await assert.rejects(createLocalPersonalCopy({
    ...fixture, originalEvent, signEvent: template => finalizeEvent(template, foreignSecret)
  }), /INVALID_PERSONAL_COPY_SIGNATURE_RESULT/)
  const denied = new Error('Permission denied')
  await assert.rejects(createLocalPersonalCopy({
    ...fixture, originalEvent, signEvent: () => { throw denied }
  }), error => error === denied)
  const badSignature = await createLocalPersonalCopy({
    ...fixture, originalEvent, signEvent: async template => ({ ...await fixture.signEvent(template), sig: '0'.repeat(128) })
  })
  assert.equal((await a.db.add(badSignature)).code, 'invalid')
  assert.equal((await getNostrDbQuotaUsage()).privateCount, 0)
})

it('cloned, changed and cross-owner wrappers do not reuse local preparation', async () => {
  const a = await owner()
  const b = await owner()
  const fixture = localCopyFixture(a)
  const originalEvent = { kind: 9, created_at: 123, content: 'original', tags: [] }
  const event = await createLocalPersonalCopy({ ...fixture, originalEvent })
  assert.equal((await a.db.add(structuredClone(event))).stored, true)
  assert.equal(fixture.calls.decrypt, 1)
  // A validly re-signed mutation must still have its plaintext inspected.
  Object.assign(event, finalizeEvent({ ...event, content: 'bad cipher' }, a.secret))
  assert.equal((await a.db.add(event)).code, 'invalid')
  assert.equal(fixture.calls.decrypt, 2)
  const other = await createLocalPersonalCopy({ ...fixture, originalEvent })
  assert.equal((await b.db.add(other)).code, 'invalid')
  assert.equal((await getNostrDbQuotaUsage()).privateCount, 1)
})

it('local personal copies preserve quota refusal and retry through ordinary admission', async () => {
  const a = await owner()
  const fixture = localCopyFixture(a)
  const originalEvent = signed({ content: 'signed third-party copy' })
  const event = await createLocalPersonalCopy({ ...fixture, originalEvent })
  await limits({ privateBytes: 0 })
  assert.equal((await a.db.add(event)).code, 'quota')
  assert.equal(fixture.calls.decrypt, 0)
  assert.equal(await row(a.raw, event), undefined)
  await limits({ privateBytes: byteSize(event) })
  assert.equal((await a.db.add(event)).stored, true)
  assert.equal(fixture.calls.decrypt, 1)
  assert.equal((await getNostrDbQuotaUsage()).privateCount, 1)
})

it('rolls back a private deletion when the envelope admission fails', async () => {
  const a = await owner()
  const fixture = localCopyFixture(a)
  const original = { kind: 9, created_at: 123, content: 'delete me', tags: [] }
  const target = await createLocalPersonalCopy({ ...fixture, originalEvent: original })
  assert.equal((await a.db.add(target)).stored, true)

  const deletion = await createLocalPersonalCopy({
    ...fixture,
    originalEvent: {
      kind: 5,
      created_at: 200,
      tags: [['e', personalCopySourceId(original, { wrapperPubkey: a.pubkey })], ['k', '9']],
      content: ''
    }
  })

  await limits({ privateBytes: 0 })
  const refused = await a.db.add(deletion)
  assert.equal(refused.code, 'quota')
  assert.equal(refused.quotaCategory, 'private')
  assert.ok(await row(a.raw, target))
  assert.equal(await row(a.raw, deletion), undefined)
  assert.equal(await request(a.raw.transaction('deletions').objectStore('deletions').get(deletionEventRef(target.id, a.pubkey))), undefined)
  assert.equal((await a.db.pendingInnerMirrors(a.raw)).size, 0)

  await limits({ privateBytes: byteSize(target) + byteSize(deletion) })
  assert.equal((await a.db.add(deletion)).stored, true)
  assert.equal(await row(a.raw, target), undefined)
  const tombstone = await request(a.raw.transaction('deletions').objectStore('deletions').get(deletionEventRef(target.id, a.pubkey)))
  assert.equal(Number.isInteger(tombstone?.ca), true)
})

it('recovery event-store adapters round-trip encrypted immutable snapshots and private revocations', async () => {
  const { createPersonalCopyRecoveryStorage, encodeRecoveryRecord } = await import('libp2r2p/private-messenger/event-store')
  const a = await owner(); const fixture = localCopyFixture(a)
  a.db.personalCopyEncrypt = fixture.encrypt
  const adapterSigner = {
    getPublicKey: async () => a.pubkey,
    obfuscate: fixture.obfuscate,
    nip44v3: { decrypt: async (pubkey, kind, scope, ciphertext) => decryptBytes(a.secret, pubkey, kind, new Uint8Array(), ciphertext).slice().buffer }
  }
  const eventStore = {
    query: (...args) => a.db.query(...args),
    remove: (...args) => a.db.remove(...args),
    addPersonalCopy: (inner, options) => runNostrDbMethod({
      db: a.db, method: 'addPersonalCopy', params: [inner, options], appId: APP,
      signEvent: fixture.signEvent, personalCopyEncrypt: fixture.encrypt,
      personalCopyObfuscate: fixture.obfuscate, requestPermission: async () => {}
    })
  }
  const one = createPersonalCopyRecoveryStorage({ eventStore, signer: adapterSigner })
  const two = createPersonalCopyRecoveryStorage({ eventStore, signer: adapterSigner })
  const at = Math.floor(Date.now() / 1000)
  const grant = { controlChannelPubkey: 'a'.repeat(64), fileChannelPubkey: 'b'.repeat(64), peerPubkey: 'c'.repeat(64), receiverPubkey: 'c'.repeat(64), root: 'd'.repeat(64), size: 51000, sharedAt: at - 20, expiresAt: at + 604800 }
  await one.authorizations.put(grant)
  await two.authorizations.put(grant)
  assert.equal((await a.db.query({ kinds: [1006], '#k': ['30078'] })).results.length, 1)
  const imported = await two.authorizations.find(grant)
  assert.equal(imported.sharedAt, grant.sharedAt)
  const seed = { channelPubkey: grant.controlChannelPubkey, receiverPubkey: grant.receiverPubkey, recordType: 'routerEnvelopeRow_v1', router: { kind: 26300, pubkey: a.pubkey, created_at: at - 10, tags: [['f', a.pubkey], ['extra', '~u=12', '%7E']] }, payloadRow: '["ciphertext"]', row: JSON.stringify([grant.receiverPubkey, 'encrypted-key']), firstSeenAt: at - 10, lastSeenAt: at - 10, expiresAt: at + 604800 }
  await one.seeds.put(seed)
  const records = []; for await (const row of two.seeds.iterate({ channelPubkey: seed.channelPubkey, receiverPubkey: seed.receiverPubkey, since: at - 15, until: at })) records.push(row)
  assert.equal(records.length, 1)
  assert.deepEqual(records[0].router.tags, seed.router.tags)
  await two.authorizations.revoke([imported])
  assert.equal(await one.authorizations.find(grant), undefined)
  // A late independently encrypted copy must meet the same coordinate tombstone.
  const replay = await eventStore.addPersonalCopy(encodeRecoveryRecord('grant', grant), { context: '' })
  assert.equal(replay.result.code, 'blocked')
  assert.equal((await a.db.query({ kinds: [1006], '#k': ['5'] })).results.length, 1)
  one.close(); two.close()
})

it('flushes access statistics while the origin quota lock is held and uses transactions of 25', async t => {
  const a = await owner(); const b = await owner()
  const events = Array.from({ length: 61 }, () => signed())
  for (const event of events) await a.db.add(event)
  const before = (await access(a.raw, events[0])).lastAccessAt
  t.mock.method(Date, 'now', () => before + 61000)
  const transactions = []
  const original = a.raw.transaction.bind(a.raw)
  t.mock.method(a.raw, 'transaction', (...args) => {
    const tx = original(...args)
    if (args[0] === 'cacheAccess' && args[1] === 'readwrite') {
      const store = tx.objectStore('cacheAccess'); const get = store.get.bind(store)
      const batch = { count: 0 }; transactions.push(batch)
      store.get = key => { batch.count++; return get(key) }
    }
    return tx
  })
  queueCacheAccess(a.pubkey, events)
  await withNostrDbQuotaLock(async () => {
    await flushCacheAccess() // would deadlock if it still requested this lock
    assert.equal((await access(a.raw, events[0])).lastAccessAt, before + 61000)
  })
  assert.deepEqual(transactions.map(batch => batch.count), [25, 25, 11])
  assert.equal((await b.db.add(signed({}, b.secret))).stored, true)
})

it('pipelines cache-access reads before issuing dependent updates', async t => {
  const a = await owner()
  const events = Array.from({ length: 61 }, () => signed())
  for (const event of events) await a.db.add(event)
  const before = (await access(a.raw, events[0])).lastAccessAt
  t.mock.method(Date, 'now', () => before + 61000)
  const transactions = []
  const original = a.raw.transaction.bind(a.raw)
  t.mock.method(a.raw, 'transaction', (...args) => {
    const tx = original(...args)
    if (args[0] === 'cacheAccess' && args[1] === 'readwrite') {
      const store = tx.objectStore('cacheAccess')
      const get = store.get.bind(store)
      const batch = { gets: 0, getsAtFirstResponse: null }
      transactions.push(batch)
      store.get = key => {
        const read = get(key)
        batch.gets++
        if (batch.gets === 1) {
          read.addEventListener('success', () => { batch.getsAtFirstResponse = batch.gets })
        }
        return read
      }
    }
    return tx
  })

  queueCacheAccess(a.pubkey, events)
  await flushCacheAccess()

  assert.deepEqual(transactions.map(batch => batch.gets), [25, 25, 11])
  assert.deepEqual(transactions.map(batch => batch.getsAtFirstResponse), [25, 25, 11])
  assert.equal((await access(a.raw, events[0])).lastAccessAt, before + 61000)
})

it('drops touches from deleted generations without touching replacement rows or opening databases', async t => {
  const a = await owner(); const event = signed()
  await a.db.add(event)
  const before = (await access(a.raw, event)).lastAccessAt
  t.mock.method(Date, 'now', () => before + 61000)
  queueCacheAccess(a.pubkey, [event])
  await deleteNostrDb(a.pubkey)
  const replacement = getNostrDb(a.pubkey, { maintenance: false })
  await replacement.add(event)
  const raw = await openNostrDb(a.pubkey)
  await setAccessTimes(raw, [[event, 123]])
  const open = t.mock.method(indexedDB, 'open', () => assert.fail('touches must never open a database'))
  await flushCacheAccess()
  assert.equal((await access(raw, event)).lastAccessAt, 123)
  open.mock.restore()
  queueCacheAccess(a.pubkey, [event])
  await deleteNostrDb(a.pubkey)
  t.mock.method(indexedDB, 'open', () => assert.fail('must not recreate a deleted database'))
  await flushCacheAccess()
  assert.ok(!(await indexedDB.databases()).some(db => db.name === NOSTRDB_PREFIX + a.pubkey))
})

it('ready counter reads avoid broad write initialization on other owners', async t => {
  const a = await owner(); const b = await owner()
  const original = b.raw.transaction.bind(b.raw)
  t.mock.method(b.raw, 'transaction', (...args) => {
    assert.ok(!(args[1] === 'readwrite' && Array.isArray(args[0]) && args[0].includes('events')))
    return original(...args)
  })
  assert.equal((await a.db.add(signed({}, a.secret))).stored, true)
  assert.equal((await getNostrDbQuotaUsage()).publicCount, 1)
})

it('revalidates last access atomically and evicts the next cold event after a raced touch', async t => {
  const a = await owner()
  const hot = signed({ content: 'a'.repeat(6000) }); const cold = signed({ content: 'b'.repeat(6000) }); const other = signed({ content: 'c'.repeat(6000) })
  for (const event of [hot, cold, other]) await a.db.add(event)
  await setAccessTimes(a.raw, [[hot, 1], [cold, 2], [other, 3]])
  await limits({ cacheBytes: Math.ceil(byteSize(hot) * 2 / 0.9) })
  const original = a.raw.transaction.bind(a.raw); let raced = false
  t.mock.method(a.raw, 'transaction', (...args) => {
    if (!raced && args[1] === 'readwrite' && Array.isArray(args[0]) && args[0].includes('events')) {
      raced = true
      original('cacheAccess', 'readwrite').objectStore('cacheAccess').put({ i: eventIdIndexKey(hot.id), lastAccessAt: 99000 })
    }
    return original(...args)
  })
  await maintainNostrDbCache()
  assert.ok(raced)
  assert.ok(await row(a.raw, hot)); assert.equal(await row(a.raw, cold), undefined)
  assert.ok(await row(a.raw, other))
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 2)
})

it('periodic rounds delete at most 25 and release the lock for admissions between rounds', async () => {
  const a = await owner(); const b = await owner()
  for (let i = 0; i < 61; i++) await a.db.add(signed())
  await limits({ cacheBytes: 0 })
  assert.equal((await maintainNostrDbCache()).excess, true)
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 36)
  assert.equal((await b.db.add(signed({}, b.secret))).stored, true)
  assert.equal((await maintainNostrDbCache()).excess, true)
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 11)
  assert.equal((await maintainNostrDbCache()).excess, false)
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 0)
})

it('caps periodic examination at 100 even when every selected timestamp changes', async t => {
  const a = await owner(); const event = signed()
  await a.db.add(event)
  await setAccessTimes(a.raw, [[event, 1]])
  await limits({ cacheBytes: 0 })
  const original = a.raw.transaction.bind(a.raw); let examinations = 0; let clock = 1
  t.mock.method(a.raw, 'transaction', (...args) => {
    if (args[0] === 'events' && args[1] === undefined) examinations++
    if (args[1] === 'readwrite' && Array.isArray(args[0]) && args[0].includes('events')) {
      original('cacheAccess', 'readwrite').objectStore('cacheAccess').put({ i: eventIdIndexKey(event.id), lastAccessAt: ++clock })
    }
    return original(...args)
  })
  assert.equal((await maintainNostrDbCache()).excess, true)
  assert.equal(examinations, 100)
  assert.ok(await row(a.raw, event))
})

it('drops queued access after read-only fencing or closing the cached handle', async t => {
  const a = await owner(); const event = signed()
  await a.db.add(event)
  const before = (await access(a.raw, event)).lastAccessAt
  t.mock.method(Date, 'now', () => before + 61000)
  queueCacheAccess(a.pubkey, [event])
  settings.set('local_nostrDbPendingDeletions', JSON.stringify({ [a.pubkey]: 'removal-generation' }))
  await flushCacheAccess()
  assert.equal((await access(a.raw, event)).lastAccessAt, before)
  settings.delete('local_nostrDbPendingDeletions')
  queueCacheAccess(a.pubkey, [event])
  a.raw.close()
  await flushCacheAccess()
})
