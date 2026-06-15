import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  NostrDb,
  ParsedFilter,
  coordinateRef,
  deleteNostrDb,
  eventRef,
  getNostrDb,
  isNewer,
  toStoredRecord
} from '../../src/services/idb/nostrdb/index.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const OWNER = 'f'.repeat(64)
const SIG = '0'.repeat(128)

describe('nostrdb', () => {
  let oldIndexedDB
  let oldIDBKeyRange

  beforeEach(() => {
    oldIndexedDB = globalThis.indexedDB
    oldIDBKeyRange = globalThis.IDBKeyRange
    globalThis.indexedDB = new FakeIndexedDB()
    globalThis.IDBKeyRange = FakeIDBKeyRange
  })

  afterEach(() => {
    globalThis.indexedDB = oldIndexedDB
    globalThis.IDBKeyRange = oldIDBKeyRange
  })

  it('derives id and coordinate refs', () => {
    const regular = event({ id: '1'.repeat(64), pubkey: A, kind: 1 })
    const dTagged = event({ id: '2'.repeat(64), pubkey: A, kind: 1, tags: [['d', 'room']] })
    const replaceable = event({ id: '3'.repeat(64), pubkey: A, kind: 0, tags: [['d', 'ignored']] })
    const addressable = event({ id: '4'.repeat(64), pubkey: A, kind: 30023, tags: [['d', 'article']] })

    assert.equal(toStoredRecord(regular).ref, eventRef(regular.id))
    assert.equal(toStoredRecord(dTagged).ref, coordinateRef(1, A, 'room'))
    assert.equal(toStoredRecord(replaceable).ref, coordinateRef(0, A, ''))
    assert.equal(toStoredRecord(addressable).ref, coordinateRef(30023, A, 'article'))
  })

  it('keeps the newest coordinate event', async () => {
    const db = getNostrDb(`${OWNER}1`)
    const old = event({ id: '1'.repeat(64), pubkey: A, kind: 30023, created_at: 10, tags: [['d', 'post']] })
    const newer = event({ id: '2'.repeat(64), pubkey: A, kind: 30023, created_at: 20, tags: [['d', 'post']] })
    const stale = event({ id: '3'.repeat(64), pubkey: A, kind: 30023, created_at: 15, tags: [['d', 'post']] })

    assert.equal(await db.add(old), true)
    assert.equal(await db.add(newer), true)
    assert.equal(await db.add(stale), false)

    const results = await db.query({ authors: [A], kinds: [30023], '#d': ['post'] })
    assert.deepEqual(results.map(e => e.id), [newer.id])
  })

  it('uses lower id as the coordinate timestamp tie-breaker', () => {
    const lower = event({ id: '1'.repeat(64), created_at: 10 })
    const higher = event({ id: '2'.repeat(64), created_at: 10 })

    assert.equal(isNewer(lower, higher), true)
    assert.equal(isNewer(higher, lower), false)
  })

  it('queries by ids, authors, kinds, author+kind, and tags', async () => {
    const db = getNostrDb(`${OWNER}2`)
    const one = event({ id: '1'.repeat(64), pubkey: A, kind: 1, created_at: 10, tags: [['e', 'root'], ['d', 'alpha']] })
    const two = event({ id: '2'.repeat(64), pubkey: A, kind: 7, created_at: 20, tags: [['p', B]] })
    const three = event({ id: '3'.repeat(64), pubkey: B, kind: 1, created_at: 30, tags: [['e', 'root'], ['d', 'alpha']] })
    const four = event({ id: '4'.repeat(64), pubkey: A, kind: 1, created_at: 40, tags: [['e', 'other']] })

    assert.equal(await db.add(one), true)
    assert.equal(await db.add(two), true)
    assert.equal(await db.add(three), true)
    assert.equal(await db.add(four), true)

    assert.deepEqual((await db.query({ ids: [one.id, two.id], kinds: [1] })).map(e => e.id), [one.id])
    assert.deepEqual((await db.query({ authors: [A] })).map(e => e.id), [four.id, two.id, one.id])
    assert.deepEqual((await db.query({ kinds: [1] })).map(e => e.id), [four.id, three.id, one.id])
    assert.deepEqual((await db.query({ authors: [A], kinds: [1], limit: 1 })).map(e => e.id), [four.id])
    assert.deepEqual((await db.query({ '#e': ['root'] })).map(e => e.id), [three.id, one.id])
    assert.deepEqual((await db.query({ '#d': ['alpha'] })).map(e => e.id), [three.id, one.id])
    assert.equal(await db.count({ kinds: [1], limit: 1 }), 3)
  })

  it('rejects filter arrays', async () => {
    const db = getNostrDb(`${OWNER}3`)

    await assert.rejects(() => db.query([{ kinds: [1] }]), /single filter/)
    await assert.rejects(() => db.count([{ kinds: [1] }]), /single filter/)
    assert.throws(() => db.subscribe([{ kinds: [1] }]), /single filter/)
  })

  it('applies NIP-09 e-tag deletion requests by author', async () => {
    const db = getNostrDb(`${OWNER}7`)
    const owned = event({ id: '1'.repeat(64), pubkey: A, kind: 1, created_at: 10 })
    const otherAuthor = event({ id: '2'.repeat(64), pubkey: B, kind: 1 })
    const deletion = event({
      id: '5'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 2,
      tags: [['e', owned.id], ['e', otherAuthor.id]]
    })

    assert.equal(await db.add(owned), true)
    assert.equal(await db.add(otherAuthor), true)
    assert.equal(await db.add(deletion), true)

    assert.deepEqual(await db.query({ ids: [owned.id] }), [])
    assert.deepEqual((await db.query({ ids: [otherAuthor.id] })).map(e => e.id), [otherAuthor.id])
    assert.deepEqual((await db.query({ ids: [deletion.id] })).map(e => e.id), [deletion.id])
  })

  it('applies NIP-09 a-tag deletion requests by coordinate author', async () => {
    const db = getNostrDb(`${OWNER}8`)
    const owned = event({ id: '1'.repeat(64), pubkey: A, kind: 30023, tags: [['d', 'post']] })
    const otherAuthor = event({ id: '2'.repeat(64), pubkey: B, kind: 30023, tags: [['d', 'post']] })
    const newer = event({ id: '3'.repeat(64), pubkey: A, kind: 30023, created_at: 10, tags: [['d', 'future']] })
    const deletion = event({
      id: '5'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 2,
      tags: [
        ['a', `30023:${A}:post`],
        ['a', `30023:${A}:future`],
        ['a', `30023:${B}:post`]
      ]
    })

    assert.equal(await db.add(owned), true)
    assert.equal(await db.add(otherAuthor), true)
    assert.equal(await db.add(newer), true)
    assert.equal(await db.add(deletion), true)

    assert.deepEqual(await db.query({ authors: [A], kinds: [30023], '#d': ['post'] }), [])
    assert.deepEqual((await db.query({ authors: [A], kinds: [30023], '#d': ['future'] })).map(e => e.id), [newer.id])
    assert.deepEqual((await db.query({ authors: [B], kinds: [30023], '#d': ['post'] })).map(e => e.id), [otherAuthor.id])
  })

  it('subscribes to future matching events', async () => {
    const db = getNostrDb(`${OWNER}4`)
    const iterator = db.subscribe({ kinds: [1] })
    const next = iterator.next()
    const match = event({ id: '1'.repeat(64), kind: 1 })

    assert.equal(await db.add(event({ id: '2'.repeat(64), kind: 7 })), true)
    assert.equal(await db.add(match), true)

    assert.deepEqual(await withTimeout(next), { value: match, done: false })
    await iterator.return()
  })

  it('receives BroadcastChannel events from another instance', async () => {
    if (typeof BroadcastChannel !== 'function') return

    const owner = `${OWNER}5`
    const receiver = new NostrDb(owner)
    const sender = new NostrDb(owner)
    const iterator = receiver.subscribe({ kinds: [1] })
    const next = iterator.next()
    const match = event({ id: '1'.repeat(64), kind: 1 })

    assert.equal(await sender.add(match), true)

    assert.deepEqual(await withTimeout(next), { value: match, done: false })
    await iterator.return()
    receiver.bc.close()
    sender.bc.close()
  })

  it('treats empty arrays and search as never matching', () => {
    assert.equal(new ParsedFilter({ ids: [] }).neverMatch, true)
    assert.equal(new ParsedFilter({ search: 'hello' }).neverMatch, true)
  })

  it('noops when IndexedDB is unavailable', async () => {
    globalThis.indexedDB = undefined
    const db = new NostrDb(`${OWNER}6`)

    assert.equal(await db.add(event({ id: '1'.repeat(64) })), false)
    assert.deepEqual(await db.query({ kinds: [1] }), [])
    assert.equal(await db.count({ kinds: [1] }), 0)
    assert.deepEqual(await db.supports(), [])
    db.bc?.close()
  })

  it('deletes a specific owner database', async () => {
    const owner = `${OWNER}9`
    const db = getNostrDb(owner)

    assert.equal(await db.add(event({ id: '1'.repeat(64) })), true)
    assert.equal(await db.count({ kinds: [1] }), 1)
    assert.equal(await deleteNostrDb(owner), true)
    assert.equal(await getNostrDb(owner).count({ kinds: [1] }), 0)
  })

  it('deletes a specific owner database through the instance API', async () => {
    const owner = `${OWNER}10`
    const db = getNostrDb(owner)

    assert.equal(await db.add(event({ id: '1'.repeat(64) })), true)
    assert.equal(await db.count({ kinds: [1] }), 1)
    assert.equal(await db.deleteDb(), true)
    assert.equal(await getNostrDb(owner).count({ kinds: [1] }), 0)
  })
})

function event ({
  id,
  pubkey = A,
  kind = 1,
  created_at = 1,
  tags = [],
  content = ''
}) {
  return { id, pubkey, kind, created_at, tags, content, sig: SIG }
}

function withTimeout (promise) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('timed out')), 1000))
  ])
}

class FakeIndexedDB {
  constructor () {
    this.databases = new Map()
  }

  open (name, version) {
    const req = new FakeRequest()
    queueMicrotask(() => {
      let db = this.databases.get(name)
      const isNew = !db

      if (!db) {
        db = new FakeDB(name, version)
        this.databases.set(name, db)
      }

      req.result = db
      if (isNew) {
        const tx = new FakeTransaction(db, 'versionchange')
        req.onupgradeneeded?.({ target: { result: db, transaction: tx } })
      }
      req.onsuccess?.({ target: req })
    })
    return req
  }

  deleteDatabase (name) {
    const req = new FakeRequest()
    queueMicrotask(() => {
      this.databases.delete(name)
      req.onsuccess?.({ target: req })
    })
    return req
  }
}

class FakeDB {
  constructor (name, version) {
    this.name = name
    this.version = version
    this.stores = new Map()
    this.objectStoreNames = namesList(this.stores)
  }

  createObjectStore (name, { keyPath }) {
    const store = new FakeStoreData(name, keyPath)
    this.stores.set(name, store)
    return new FakeObjectStore(store)
  }

  transaction (_storeNames, mode) {
    return new FakeTransaction(this, mode)
  }

  close () {}
}

class FakeTransaction {
  constructor (db, mode) {
    this.db = db
    this.mode = mode
    this.error = null
  }

  objectStore (name) {
    return new FakeObjectStore(this.db.stores.get(name), this)
  }

  abort (error) {
    this.error = error || new Error('transaction aborted')
    this.onabort?.()
  }

  completeSoon () {
    queueMicrotask(() => this.oncomplete?.())
  }
}

class FakeStoreData {
  constructor (name, keyPath) {
    this.name = name
    this.keyPath = keyPath
    this.records = new Map()
    this.indexes = new Map()
    this.indexNames = namesList(this.indexes)
  }
}

class FakeObjectStore {
  constructor (data, tx) {
    this.data = data
    this.tx = tx
    this.indexNames = data.indexNames
  }

  createIndex (name, keyPath, options = {}) {
    this.data.indexes.set(name, { name, keyPath, options })
  }

  index (name) {
    return new FakeIndex(this.data, this.data.indexes.get(name), this.tx)
  }

  get (key) {
    return request(() => this.data.records.get(key), this.tx)
  }

  put (value) {
    return request(() => {
      const key = value[this.data.keyPath]
      const byId = this.data.indexes.get('byId')
      if (byId) {
        const idKey = getByKeyPath(value, byId.keyPath)
        for (const [recordKey, record] of this.data.records) {
          if (recordKey !== key && compareKeys(getByKeyPath(record, byId.keyPath), idKey) === 0) {
            throw new Error('unique index violation')
          }
        }
      }
      this.data.records.set(key, value)
      return key
    }, this.tx)
  }

  delete (key) {
    return request(() => this.data.records.delete(key), this.tx)
  }

  openCursor (range, direction) {
    return requestCursor([...this.data.records.values()].map(value => ({ key: value.ref, value })), range, direction, this.tx)
  }
}

class FakeIndex {
  constructor (store, index, tx) {
    this.store = store
    this.index = index
    this.tx = tx
  }

  get (key) {
    return request(() => this.entries().find(entry => compareKeys(entry.key, key) === 0)?.value, this.tx)
  }

  openCursor (range, direction) {
    return requestCursor(this.entries(), range, direction, this.tx)
  }

  entries () {
    const entries = []
    for (const value of this.store.records.values()) {
      const key = getByKeyPath(value, this.index.keyPath)
      const keys = this.index.options.multiEntry && Array.isArray(key) ? key : [key]
      for (const item of keys) entries.push({ key: item, value })
    }
    return entries
  }
}

class FakeRequest {}

class FakeCursor {
  constructor (req, entries, index) {
    this.req = req
    this.entries = entries
    this.index = index
    this.value = entries[index].value
    this.key = entries[index].key
  }

  continue () {
    this.index++
    queueMicrotask(() => {
      this.req.result = this.entries[this.index] ? new FakeCursor(this.req, this.entries, this.index) : undefined
      this.req.onsuccess?.({ target: this.req })
    })
  }
}

class FakeIDBKeyRange {
  static bound (lower, upper) {
    return new FakeIDBKeyRange(lower, upper, false, false)
  }

  static only (value) {
    return new FakeIDBKeyRange(value, value, false, false)
  }

  constructor (lower, upper, lowerOpen, upperOpen) {
    this.lower = lower
    this.upper = upper
    this.lowerOpen = lowerOpen
    this.upperOpen = upperOpen
  }

  includes (key) {
    const lower = compareKeys(key, this.lower)
    const upper = compareKeys(key, this.upper)
    return (this.lowerOpen ? lower > 0 : lower >= 0) && (this.upperOpen ? upper < 0 : upper <= 0)
  }
}

function request (fn, tx) {
  const req = new FakeRequest()
  queueMicrotask(() => {
    try {
      req.result = fn()
      req.onsuccess?.({ target: req })
      tx?.completeSoon()
    } catch (error) {
      req.error = error
      req.onerror?.({ target: req })
      tx?.abort(error)
    }
  })
  return req
}

function requestCursor (entries, range, direction, tx) {
  const req = new FakeRequest()
  queueMicrotask(() => {
    const filtered = entries
      .filter(entry => !range || range.includes(entry.key))
      .sort((a, b) => compareKeys(a.key, b.key))
    if (direction === 'prev') filtered.reverse()

    req.result = filtered[0] ? new FakeCursor(req, filtered, 0) : undefined
    req.onsuccess?.({ target: req })
    tx?.completeSoon()
  })
  return req
}

function getByKeyPath (value, keyPath) {
  if (Array.isArray(keyPath)) return keyPath.map(key => value[key])
  return value[keyPath]
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

function namesList (map) {
  return {
    contains: name => map.has(name)
  }
}
