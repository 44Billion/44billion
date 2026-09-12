import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'
import { finalizeEvent } from 'libp2r2p/event'
import { getPublicKey } from 'libp2r2p/key'
import { buildPersonalCopyUnsignedEvent } from '#helpers/personal-copy.js'
import {
  getNostrDb, openNostrDb, deleteNostrDb, eventIdIndexKey,
  NOSTRDB_PREFIX, toStoredRecord
} from '#services/idb/nostrdb/index.js'
import {
  DEFAULT_NOSTRDB_QUOTAS, getNostrDbQuotaUsage, setNostrDbQuotaLimits,
  maintainNostrDbCache, queueCacheAccess, flushCacheAccess, ownerReferenceKeys,
  startGlobalQuotaMaintenance, cacheEventLimit, getNostrDbQuotaLimits
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
  const refused = await a.db.add(signed({}, a.secret))
  assert.equal(refused.code, 'quota')
  assert.equal(refused.quotaCategory, 'public')
  assert.equal((await row(a.raw, first)).eventBytes, byteSize(first))
  assert.equal((await a.db.add(first)).code, 'duplicate')
})

it('serializes competing admissions for the last available global bytes', async () => {
  const a = await owner()
  const b = await owner()
  const first = signed({}, a.secret)
  const second = signed({}, b.secret)
  await limits({ publicBytes: Math.max(byteSize(first), byteSize(second)) })
  const results = await Promise.all([a.db.add(first), b.db.add(second)])
  assert.equal(results.filter(result => result.stored).length, 1)
  assert.equal(results.filter(result => result.quotaCategory === 'public').length, 1)
  assert.equal((await getNostrDbQuotaUsage()).publicCount, 1)
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
  assert.equal((await openNostrDb(pubkey)).version, 3)
})

it('fails closed when database enumeration is unavailable', async t => {
  const a = await owner()
  const mock = t.mock.method(indexedDB, 'databases', async () => { throw new Error('unavailable enumeration') })
  assert.equal((await a.db.add(signed())).code, 'unavailable')
  mock.mock.restore()
  assert.equal((await getNostrDbQuotaUsage()).publicCount, 0)
})

it('keeps a pending replacement intact even when cache eviction cannot make it fit', async () => {
  const a = await owner()
  const b = await owner()
  const old = signed({ kind: 30023, tags: [['d', 'post']], content: 'x'.repeat(200) })
  const other = signed()
  const larger = signed({ kind: 30023, tags: [['d', 'post']], content: 'x'.repeat(6000) })
  await a.db.add(old)
  await b.db.add(other)
  await limits({ cacheBytes: byteSize(larger) - 1 })
  const result = await a.db.add(larger)
  assert.equal(result.quotaCategory, 'cache')
  assert.ok(await row(a.raw, old))
  assert.equal(await row(a.raw, larger), undefined)
  assert.equal(await row(b.raw, other), undefined)
  assert.equal((await getNostrDbQuotaUsage()).cacheBytes, byteSize(old))
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
  const delivered = (await subscription.next()).value.result
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
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { calls.push({ fn, ms }); return { unref () {} } })
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
  assert.equal((await access(a.raw, delivered.result)).lastAccessAt, now - 61000)
  a.db.recordCacheAccess(delivered, {}, options)
  await subscription.return()
  await flushCacheAccess()
  assert.equal((await access(a.raw, delivered.result)).lastAccessAt, now)
  const other = delivered.result.id === first.id ? second : first
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

it('enforces proportional count during admission and cleans both cache limits after reduction', async () => {
  const a = await owner()
  const first = signed()
  const second = signed()
  await limits({ cacheBytes: 3000 }) // one event, though both fit in bytes
  await a.db.add(first)
  assert.equal((await a.db.add(second)).stored, true)
  assert.equal(await row(a.raw, first), undefined)
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 1)
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
  assert.equal((await a.db.removeLocal([['e', first.id]])).code, 'noop')
  const result = await a.db.removeLocal([
    ['e', newer.id.toUpperCase()], ['e', newer.id],
    ['a', `030023:${newer.pubkey.toUpperCase()}:part:two`], ['e', '0'.repeat(64)]
  ])
  assert.deepEqual(result, { ok: true, code: 'deleted', message: 'Events were removed locally.', deleted: 1 })
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
    const result = await a.db.removeLocal(invalid, { assertAccess () { assert.fail('invalid input must be rejected first') } })
    assert.equal(result.code, 'invalid')
    assert.equal(result.deleted, 0)
    assert.ok(await row(a.raw, event))
  }
  assert.equal((await a.db.removeLocal(Array(100).fill(['e', event.id]))).deleted, 1)
})

it('allows local removal above quotas, demotes referenced targets and removes protected/shared records', async () => {
  const a = await owner()
  const target = signed()
  await a.db.add(target, { appId: APP })
  const ref = signed({ tags: [['x', target.id]] }, a.secret)
  await a.db.add(ref)
  assert.equal(await access(a.raw, target), undefined)
  await limits({ publicBytes: 0, cacheBytes: 0 })
  assert.equal((await a.db.removeLocal([['e', ref.id]])).deleted, 1)
  assert.ok(await access(a.raw, target))
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 1)
  assert.equal((await a.db.removeLocal([['e', target.id]])).deleted, 1)
  assert.equal((await getNostrDbQuotaUsage()).publicBytes, 0)
})

it('removes deletion-request contributions and permits the deleted event to return', async () => {
  const a = await owner()
  const event = signed()
  await a.db.add(event)
  const deletion = signed({ kind: 5, tags: [['e', event.id]] })
  await a.db.add(deletion)
  assert.equal(await row(a.raw, event), undefined)
  assert.equal((await a.db.removeLocal([['e', deletion.id]])).deleted, 1)
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
  assert.equal((await a.db.removeLocal([['e', ref.id], ['e', target.id]])).code, 'error')
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
    db: a.db, method: 'removeLocal', params: [[['a', `30023:${first.pubkey}:`]]],
    requestPermission: async () => { requested.resolve(); await permission.promise }
  })
  await requested.promise
  assert.equal((await a.db.add(newer)).stored, true)
  permission.resolve()
  assert.equal((await deletion).deleted, 1)
  assert.equal(await row(a.raw, newer), undefined)
  await a.db.add(newer)
  let checks = 0
  await assert.rejects(a.db.removeLocal([['e', newer.id]], {
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
  assert.equal((await a.db.removeLocal([['e', inner.id]])).code, 'noop')
  await limits({ privateBytes: 0 })
  assert.equal((await a.db.removeLocal([['e', wrapper.id]])).deleted, 1)
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

it('reserves the referrer globally, ranks promotions by access/ID and skips oversized targets', async () => {
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
  for (const event of [tied[0], small]) {
    assert.ok(await row(a.raw, event))
    assert.equal(await access(a.raw, event), undefined)
  }
  for (const event of [huge, tied[1]]) assert.equal(await row(a.raw, event), undefined)
  assert.equal((await getNostrDbQuotaUsage()).publicBytes, budget)
  assert.equal((await getNostrDbQuotaUsage()).publicCount, 4)
  assert.equal((await getNostrDbQuotaUsage()).cacheCount, 0)
  assert.equal((await a.db.add(huge)).quotaCategory, 'public', 'a referenced target cannot return as cache')
  await a.db.removeLocal([['e', ref.id]])
  assert.equal((await a.db.add(huge)).stored, true, 'promotion discard created no tombstone')
  const usage = await getNostrDbQuotaUsage()
  assert.equal(usage.publicBytes, byteSize(otherOwner))
  assert.equal(usage.cacheCount, 3)
})

it('drops only newly protected cache when all public room is reserved for the owner', async () => {
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
  assert.equal(await row(a.raw, cached), undefined)
  assert.equal((await getNostrDbQuotaUsage()).publicBytes, usage.publicBytes + byteSize(ref))
})

it('refuses an owner event that itself cannot fit without deleting any cache', async () => {
  const a = await owner()
  const target = signed()
  await a.db.add(target)
  const ref = signed({ tags: [['x', target.id]] }, a.secret)
  const before = await getNostrDbQuotaUsage()
  await limits({ publicBytes: byteSize(ref) - 1 })
  assert.equal((await a.db.add(ref)).quotaCategory, 'public')
  assert.equal(await row(a.raw, ref), undefined)
  assert.ok(await row(a.raw, target))
  assert.ok(await access(a.raw, target))
  assert.deepEqual(await getNostrDbQuotaUsage(), before)
})

it('uses net replacement room for promotions even with a zero public limit', async () => {
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

it('rolls back the owner replacement, promotions, discards and access times together', async t => {
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
  assert.equal(await row(a.raw, target), undefined)
  const usage = await getNostrDbQuotaUsage()
  assert.equal(usage.privateBytes, byteSize(wrapper))
  assert.equal(usage.publicBytes, 0)
  assert.equal(usage.cacheBytes, 0)
})

it('removes old deletion contributions when a cached kind 5 cannot be promoted', async () => {
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
  assert.equal(await row(a.raw, deletion), undefined)
  assert.equal(await request(a.raw.transaction('deletions').objectStore('deletions').count()), 0)
  assert.equal((await a.db.add(target)).stored, true)
  assert.equal((await getNostrDbQuotaUsage()).publicBytes, byteSize(ref))
  assert.equal((await getNostrDbQuotaUsage()).cacheBytes, byteSize(target))
})

it('does not discard newly arriving referenced events or already preserved versions to fit admission', async () => {
  const a = await owner()
  const old = signed({ kind: 30023, tags: [['d', 'protected']] })
  const newer = signed({ kind: 30023, tags: [['d', 'protected']], content: 'larger' })
  const ref = signed({ tags: [['a', `30023:${old.pubkey}:protected`]] }, a.secret)
  await a.db.add(ref)
  await limits({ publicBytes: byteSize(ref) })
  assert.equal((await a.db.add(old)).quotaCategory, 'public')
  assert.equal(await row(a.raw, old), undefined)
  await limits({ publicBytes: byteSize(ref) + byteSize(old) })
  assert.equal((await a.db.add(old)).stored, true)
  const before = await getNostrDbQuotaUsage()
  assert.equal((await a.db.add(newer)).quotaCategory, 'public')
  assert.ok(await row(a.raw, old))
  assert.equal(await row(a.raw, newer), undefined)
  assert.deepEqual(await getNostrDbQuotaUsage(), before)
})
