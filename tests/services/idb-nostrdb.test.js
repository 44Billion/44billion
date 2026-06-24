import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  INDEX,
  DELETIONS_STORE,
  KIND_REGISTRY_STORE,
  NostrDb,
  NOSTRDB_PREFIX,
  ParsedFilter,
  addressKey,
  coordinateRef,
  deleteNostrDb,
  deletionCoordinateRef,
  deletionEventRef,
  eventRef,
  eventIdIndexKey,
  getNostrDb,
  isNewer,
  openNostrDb,
  pubkeyIndexKey,
  toStoredRecord
} from '../../src/services/idb/nostrdb/index.js'
import { buildCrdtMergeTemplate } from '../../src/services/idb/nostrdb/crdt.js'
import { isScheduledDurableFuture } from '../../src/services/idb/nostrdb/scheduled.js'
import { eventKinds } from '../../src/constants/event.js'
import { appIdToDbAppRef } from '../../src/helpers/app.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const OWNER = 'f'.repeat(64)
const SIG = '0'.repeat(128)
const APP1 = `a${'1'.repeat(43)}one`
const APP2 = `a${'2'.repeat(43)}two`
let consoleErrors = []
let consoleWarns = []

describe('nostrdb', () => {
  let oldIndexedDB
  let oldIDBKeyRange
  let oldConsoleError
  let oldConsoleWarn

  beforeEach(() => {
    oldIndexedDB = globalThis.indexedDB
    oldIDBKeyRange = globalThis.IDBKeyRange
    oldConsoleError = console.error
    oldConsoleWarn = console.warn
    consoleErrors = []
    consoleWarns = []
    globalThis.indexedDB = new FakeIndexedDB()
    globalThis.IDBKeyRange = FakeIDBKeyRange
    console.error = (...args) => consoleErrors.push(args)
    console.warn = (...args) => consoleWarns.push(args)
  })

  afterEach(() => {
    globalThis.indexedDB = oldIndexedDB
    globalThis.IDBKeyRange = oldIDBKeyRange
    console.error = oldConsoleError
    console.warn = oldConsoleWarn
  })

  it('derives id and coordinate refs', () => {
    const regular = event({ id: '1'.repeat(64), pubkey: A, kind: 1 })
    const dTagged = event({ id: '2'.repeat(64), pubkey: A, kind: 1, tags: [['d', 'room']] })
    const replaceable = event({ id: '3'.repeat(64), pubkey: A, kind: 0, tags: [['d', 'ignored']] })
    const addressable = event({ id: '4'.repeat(64), pubkey: A, kind: 30023, tags: [['d', 'article']] })
    const expiring = event({ id: '5'.repeat(64), tags: [['expiration', '100']] })

    assert.equal(toStoredRecord(regular).i, eventRef(regular.id))
    assert.equal('a' in toStoredRecord(regular), false)
    assert.deepEqual(toStoredRecord(dTagged).a, addressKey(1, A, 'room'))
    assert.deepEqual(toStoredRecord(dTagged).a, coordinateRef(1, A, 'room'))
    assert.deepEqual(toStoredRecord(replaceable).a, addressKey(0, A, ''))
    assert.deepEqual(toStoredRecord(addressable).a, addressKey(30023, A, 'article'))
    assert.equal(toStoredRecord(expiring, { now: 50 }).ex, 100)
    assert.equal('ex' in toStoredRecord(regular), false)
  })

  it('derives deletion refs', () => {
    const id = '1'.repeat(64)

    assert.equal(deletionEventRef(id, A), `e:${eventIdIndexKey(id)}:${pubkeyIndexKey(A)}`)
    assert.equal(deletionCoordinateRef(30023, A, 'post'), `a:${addressKey(30023, A, 'post').join(':')}`)
  })

  it('detects scheduled durable future events', () => {
    const isNonDurableEvent = event => event.kind >= 20000 && event.kind < 30000

    assert.equal(isScheduledDurableFuture(event({ id: '1'.repeat(64), created_at: 103 }), {
      now: 100,
      isNonDurableEvent
    }), true)
    assert.equal(isScheduledDurableFuture(event({ id: '2'.repeat(64), created_at: 102 }), {
      now: 100,
      isNonDurableEvent
    }), false)
    assert.equal(isScheduledDurableFuture(event({ id: '3'.repeat(64), kind: 20000, created_at: 103 }), {
      now: 100,
      isNonDurableEvent
    }), false)
  })

  it('stores app refs only for custom app-data and unknown kinds', async () => {
    const owner = `${OWNER}72`
    const db = getNostrDb(owner)
    const appRef = appIdToDbAppRef(APP1)
    const regularCustom = event({ id: '1'.repeat(64), kind: eventKinds.REGULAR_CUSTOM_APP_DATA })
    const addressableCustom = event({ id: '2'.repeat(64), kind: eventKinds.CUSTOM_APP_DATA, tags: [['d', 'settings']] })
    const unknown = event({ id: '3'.repeat(64), kind: 40000 })
    const known = event({ id: '4'.repeat(64), kind: eventKinds.TEXT_NOTE })

    assert.deepEqual(toStoredRecord(regularCustom, { appRef }).ap, [appRef])
    assert.deepEqual(toStoredRecord(addressableCustom, { appRef }).ap, [appRef])
    assert.deepEqual(toStoredRecord(unknown, { appRef }).ap, [appRef])
    assert.equal('ap' in toStoredRecord(known, { appRef }), false)

    assertAddOk(await db.add(regularCustom, { appId: APP1 }))
    assertAddOk(await db.add(addressableCustom, { appId: APP1 }))
    assertAddOk(await db.add(unknown, { appId: APP1 }))
    assertAddOk(await db.add(known, { appId: APP1 }))

    const store = fakeStore(owner, 'events')
    assert.equal(store.indexes.has(INDEX.app), true)
    assert.deepEqual(store.records.get(eventIdIndexKey(regularCustom.id)).ap, [appRef])
    assert.deepEqual(store.records.get(eventIdIndexKey(addressableCustom.id)).ap, [appRef])
    assert.deepEqual(store.records.get(eventIdIndexKey(unknown.id)).ap, [appRef])
    assert.equal('ap' in store.records.get(eventIdIndexKey(known.id)), false)
    assert.equal(fakeStore(owner, KIND_REGISTRY_STORE).records.has('appNeutralKinds'), true)
  })

  it('rejects invalid app ids without storing events', async () => {
    const owner = `${OWNER}73`
    const db = getNostrDb(owner)
    const custom = event({ id: '1'.repeat(64), kind: eventKinds.CUSTOM_APP_DATA, tags: [['d', 'settings']] })

    assertAddNotOk(await db.add(custom, { appId: 'nope' }), { code: 'invalid_app' })
    assert.deepEqual(await queryResults(db, { ids: [custom.id] }), [])
  })

  it('merges app refs into duplicate and superseded custom events', async () => {
    const owner = `${OWNER}74`
    const db = getNostrDb(owner)
    const duplicate = event({ id: '1'.repeat(64), kind: eventKinds.REGULAR_CUSTOM_APP_DATA })
    const newer = event({ id: '2'.repeat(64), kind: eventKinds.CUSTOM_APP_DATA, created_at: 20, tags: [['d', 'settings']] })
    const stale = event({ id: '3'.repeat(64), kind: eventKinds.CUSTOM_APP_DATA, created_at: 10, tags: [['d', 'settings']] })

    assertAddOk(await db.add(duplicate, { appId: APP1 }), { code: 'stored', stored: true })
    assertAddOk(await db.add(duplicate, { appId: APP2 }), { code: 'duplicate', stored: true, published: false })
    assertAppRefs(fakeStore(owner, 'events').records.get(eventIdIndexKey(duplicate.id)), [APP1, APP2])

    assertAddOk(await db.add(newer, { appId: APP1 }), { code: 'stored', stored: true })
    assertAddOk(await db.add(stale, { appId: APP2 }), { code: 'superseded', stored: true, published: false })
    assertAppRefs(fakeStore(owner, 'events').records.get(eventIdIndexKey(newer.id)), [APP1, APP2])
    assert.deepEqual((await queryResults(db, { kinds: [eventKinds.CUSTOM_APP_DATA], '#d': ['settings'] })).map(e => e.id), [newer.id])
  })

  it('preserves app refs across coordinate replacement', async () => {
    const owner = `${OWNER}75`
    const db = getNostrDb(owner)
    const old = event({ id: '1'.repeat(64), kind: eventKinds.CUSTOM_APP_DATA, created_at: 10, tags: [['d', 'settings']] })
    const newer = event({ id: '2'.repeat(64), kind: eventKinds.CUSTOM_APP_DATA, created_at: 20, tags: [['d', 'settings']] })

    assertAddOk(await db.add(old, { appId: APP1 }), { code: 'stored', stored: true })
    assertAddOk(await db.add(newer, { appId: APP2 }), { code: 'replaced', stored: true })
    assertAppRefs(fakeStore(owner, 'events').records.get(eventIdIndexKey(newer.id)), [APP1, APP2])
    assert.deepEqual(await queryResults(db, { ids: [old.id] }), [])
  })

  it('deletes exclusive app rows and only unlinks shared app rows', async () => {
    const owner = `${OWNER}76`
    const db = getNostrDb(owner)
    const exclusive = event({ id: '1'.repeat(64), kind: eventKinds.CUSTOM_APP_DATA, tags: [['d', 'one']] })
    const shared = event({ id: '2'.repeat(64), kind: eventKinds.REGULAR_CUSTOM_APP_DATA })

    assertAddOk(await db.add(exclusive, { appId: APP1 }))
    assertAddOk(await db.add(shared, { appId: APP1 }))
    assertAddOk(await db.add(shared, { appId: APP2 }), { code: 'duplicate', stored: true, published: false })

    assert.equal(await db.deleteEventsByApp(APP1), 1)
    assert.deepEqual(await queryResults(db, { ids: [exclusive.id] }), [])
    assert.deepEqual((await queryResults(db, { ids: [shared.id] })).map(e => e.id), [shared.id])
    assertAppRefs(fakeStore(owner, 'events').records.get(eventIdIndexKey(shared.id)), [APP2])

    assert.equal(await db.deleteEventsByApp(APP2), 1)
    assert.deepEqual(await queryResults(db, { ids: [shared.id] }), [])
    assert.equal(await db.deleteEventsByApp('nope'), 0)
  })

  it('deletes app rows in bounded batches', async () => {
    const owner = `${OWNER}79`
    const db = getNostrDb(owner)
    const exclusive = []

    for (let i = 1; i <= 69; i++) {
      const item = event({ id: hexId(i), kind: eventKinds.REGULAR_CUSTOM_APP_DATA })
      exclusive.push(item)
      assertAddOk(await db.add(item, { appId: APP1 }))
    }

    const shared = event({ id: hexId(1000), kind: eventKinds.REGULAR_CUSTOM_APP_DATA })
    assertAddOk(await db.add(shared, { appId: APP1 }))
    assertAddOk(await db.add(shared, { appId: APP2 }), { code: 'duplicate', stored: true, published: false })

    const store = fakeStore(owner, 'events')
    store.openKeyCursorCount = 0

    assert.equal(await db.deleteEventsByApp(APP1), exclusive.length)
    assert.equal(store.openKeyCursorCount > 1, true)
    assert.deepEqual(await queryResults(db, { ids: exclusive.map(event => event.id) }), [])
    assert.deepEqual((await queryResults(db, { ids: [shared.id] })).map(e => e.id), [shared.id])
    assertAppRefs(store.records.get(eventIdIndexKey(shared.id)), [APP2])
  })

  it('exports app rows in resumable batches', async () => {
    const owner = `${OWNER}93`
    const db = getNostrDb(owner)
    const events = []

    for (let i = 1; i <= 5; i++) {
      const item = event({ id: hexId(i), kind: eventKinds.REGULAR_CUSTOM_APP_DATA })
      events.push(item)
      assertAddOk(await db.add(item, { appId: APP1 }))
    }

    const otherApp = event({ id: hexId(100), kind: eventKinds.REGULAR_CUSTOM_APP_DATA })
    const known = event({ id: hexId(101), kind: eventKinds.TEXT_NOTE })
    assertAddOk(await db.add(otherApp, { appId: APP2 }))
    assertAddOk(await db.add(known, { appId: APP1 }))

    const batches = await exportEventBatches(db, APP1, { batchSize: 2 })
    const ids = batches.flat().map(event => event.id)
    assert.deepEqual(batches.map(batch => batch.length), [2, 2, 1])
    assert.deepEqual([...ids].sort(), events.map(event => event.id).sort())

    assert.deepEqual(
      (await exportEventBatches(db, APP1, { batchSize: 2, skip: 2 })).flat().map(event => event.id),
      ids.slice(2)
    )
    assert.deepEqual(
      (await exportEventBatches(db, APP1, { batchSize: 2, after: ids[1] })).flat().map(event => event.id),
      ids.slice(2)
    )
    assert.deepEqual(await exportEventBatches(db, APP1, { after: hexId(999) }), [])
    assert.deepEqual(await exportEventBatches(db, 'nope'), [])
  })

  it('removes app refs when stored unknown kinds become known', async () => {
    const owner = `${OWNER}77`
    const dbName = `${NOSTRDB_PREFIX}${owner}`
    const db = new FakeDB(dbName, 1)
    const text = event({ id: '1'.repeat(64), kind: eventKinds.TEXT_NOTE })
    const custom = event({ id: '2'.repeat(64), kind: eventKinds.CUSTOM_APP_DATA, tags: [['d', 'settings']] })
    const appRef = appIdToDbAppRef(APP1)
    const staleTextRecord = toStoredRecord(text)
    staleTextRecord.ap = [appRef]

    createNostrDbSchema(db)
    db.stores.get('events').records.set(eventIdIndexKey(text.id), staleTextRecord)
    db.stores.get('events').records.set(eventIdIndexKey(custom.id), toStoredRecord(custom, { appRef }))
    db.stores.get(KIND_REGISTRY_STORE).records.set('appNeutralKinds', {
      key: 'appNeutralKinds',
      kinds: []
    })
    globalThis.indexedDB.databases.set(dbName, db)

    await openNostrDb(owner)

    assert.equal('ap' in db.stores.get('events').records.get(eventIdIndexKey(text.id)), false)
    assertAppRefs(db.stores.get('events').records.get(eventIdIndexKey(custom.id)), [APP1])
    assert.deepEqual(db.stores.get(KIND_REGISTRY_STORE).records.get('appNeutralKinds'), {
      key: 'appNeutralKinds',
      kinds: appNeutralKindListForTest()
    })
  })

  it('returns structured add results for accepted and rejected events', async () => {
    const db = getNostrDb(`${OWNER}66`)
    const first = event({ id: '1'.repeat(64), created_at: 10 })
    const old = event({ id: '2'.repeat(64), kind: 30023, created_at: 10, tags: [['d', 'post']] })
    const newer = event({ id: '3'.repeat(64), kind: 30023, created_at: 20, tags: [['d', 'post']] })
    const stale = event({ id: '4'.repeat(64), kind: 30023, created_at: 15, tags: [['d', 'post']] })
    const deletedId = '5'.repeat(64)
    const deletion = event({ id: '6'.repeat(64), kind: 5, created_at: 30, tags: [['e', deletedId]] })

    assertAddOk(await db.add(first), { code: 'stored', stored: true, published: true })

    const duplicateIterator = db.subscribe({ ids: [first.id] })
    const duplicateNext = duplicateIterator.next()
    assertAddOk(await db.add(first), { code: 'duplicate', stored: false, published: false })
    assert.equal(await settlesWithin(duplicateNext), false)
    await duplicateIterator.return()

    assertAddOk(await db.add(old), { code: 'stored', stored: true, published: true })
    assertAddOk(await db.add(newer), { code: 'replaced', stored: true, published: true })
    assertAddOk(await db.add(stale), { code: 'superseded', stored: false, published: false })
    assertAddOk(await db.add(deletion), { code: 'stored', stored: true, published: true })
    assertAddNotOk(await db.add(event({ id: deletedId, created_at: 40 })), { code: 'blocked' })
    assertAddNotOk(await db.add({}), { code: 'invalid' })

    const fake = globalThis.indexedDB.databases.get(`${NOSTRDB_PREFIX}${OWNER}66`)
    const originalTransaction = fake.transaction
    fake.transaction = () => {
      throw new Error('boom')
    }
    assertAddNotOk(await db.add(event({ id: '7'.repeat(64), created_at: 50 })), { code: 'error' })
    fake.transaction = originalTransaction
  })

  it('enriches and signs owner-authored coordinate events when CRDT merge is enabled', async () => {
    const owner = hexId(30000)
    const db = getNostrDb(owner)
    const input = event({
      id: hexId(1),
      pubkey: owner,
      kind: 30023,
      created_at: 10,
      tags: [['d', 'post'], ['p', B]],
      content: 'hello'
    })
    let seenTemplate

    const result = await db.add(input, {
      signEvent: template => {
        seenTemplate = cloneJson(template)
        return signedFromTemplate(template, { id: hexId(2), pubkey: owner })
      }
    })

    assertAddOk(result, { code: 'stored', stored: true, published: true })
    assert.equal(result.merged, true)
    assert.equal(result.inputId, input.id)
    assert.equal(result.storedId, hexId(2))
    assert.equal(seenTemplate.kind, 30023)
    assert.equal(seenTemplate.pubkey, owner)
    assert.equal(seenTemplate.created_at, 10)
    assert.equal(seenTemplate.content, 'hello')
    assertNormalTag(seenTemplate.tags[0], ['d', 'post'], 10)
    assertNormalTag(seenTemplate.tags[1], ['p', B], 10)
    assertContentClock(seenTemplate.tags[2], 10)
    assert.deepEqual(await queryResults(db, { ids: [input.id] }), [])
    assert.deepEqual((await queryResults(db, { ids: [hexId(2)] })).map(event => event.id), [hexId(2)])
  })

  it('uses only canonical CRDT metadata and treats old u@ strings as ordinary values', async () => {
    const owner = hexId(30020)
    const db = getNostrDb(owner)
    const input = event({
      id: hexId(1),
      pubkey: owner,
      kind: 30023,
      created_at: 10,
      tags: [['d', 'post', 'u@ 999'], ['x', 'bad', '~not-valid']],
      content: 'metadata'
    })
    let seenTemplate

    await db.add(input, {
      signEvent: template => {
        seenTemplate = cloneJson(template)
        return signedFromTemplate(template, { id: hexId(2), pubkey: owner })
      }
    })

    assertNormalTag(seenTemplate.tags[0], ['d', 'post', 'u@ 999'], 10)
    assertNormalTag(seenTemplate.tags[1], ['x', 'bad'], 10)
    assertContentClock(seenTemplate.tags[2], 10)
    assert.equal(seenTemplate.tags.flat().includes('~not-valid'), false)
  })

  it('caps explicit CRDT clocks to now or event created_at plus skew', async () => {
    await withPatchedNow(100, async () => {
      const owner = hexId(30006)
      const db = getNostrDb(owner)
      const input = event({
        id: hexId(1),
        pubkey: owner,
        kind: 30023,
        created_at: 10,
        tags: [
          ['d', 'post', '~u=999;o=00000001'],
          ['p', B, '~u=999;o=00000002'],
          ['~', 'u=999']
        ],
        content: 'capped'
      })
      let seenTemplate

      await db.add(input, {
        signEvent: template => {
          seenTemplate = cloneJson(template)
          return signedFromTemplate(template, { id: hexId(2), pubkey: owner })
        }
      })

      assertNormalTag(seenTemplate.tags[0], ['d', 'post'], 160)
      assertNormalTag(seenTemplate.tags[1], ['p', B], 160)
      assertContentClock(seenTemplate.tags[2], 160)
    })
  })

  it('allows CRDT clocks that fit a scheduled event created_at plus skew', async () => {
    await withPatchedNow(100, async () => {
      const owner = hexId(30007)
      const db = getNostrDb(owner)
      const input = event({
        id: hexId(1),
        pubkey: owner,
        kind: 30023,
        created_at: 1000,
        tags: [
          ['d', 'post'],
          ['p', B, '~u=1055;o=00000002'],
          ['t', 'too-far', '~u=2000;o=00000003'],
          ['~', 'u=1055']
        ],
        content: 'scheduled'
      })
      let seenTemplate

      await db.add(input, {
        signEvent: template => {
          seenTemplate = cloneJson(template)
          return signedFromTemplate(template, { id: hexId(2), pubkey: owner })
        }
      })

      assertNormalTag(seenTemplate.tags[0], ['d', 'post'], 1000)
      assertNormalTag(seenTemplate.tags[1], ['p', B], 1055)
      assertNormalTag(seenTemplate.tags[2], ['t', 'too-far'], 1060)
      assertContentClock(seenTemplate.tags[3], 1055)
    })
  })

  it('caps preserved CRDT tombstone clocks while keeping their tag name', async () => {
    await withPatchedNow(100, async () => {
      const owner = hexId(30008)
      const db = getNostrDb(owner)
      const old = event({
        id: hexId(1),
        pubkey: owner,
        kind: 30023,
        created_at: 10,
        tags: [['d', 'post'], ['z', `p^${B}`, '~u=999;i=0,1']]
      })
      const incoming = event({
        id: hexId(2),
        pubkey: owner,
        kind: 30023,
        created_at: 20,
        tags: [['d', 'post']]
      })

      assertAddOk(await db.add(old))
      await db.add(incoming, {
        signEvent: template => signedFromTemplate(template, { id: hexId(3), pubkey: owner })
      })

      const [stored] = await queryResults(db, { ids: [hexId(3)] })
      assertTombstoneTag(stored.tags.at(-1), 'z', `p^${B}`, 160, [0, 1])
    })
  })

  it('uses incoming-first local tag order and appends surviving existing-only tags', async () => {
    const tags = await mergedTagOrder({
      owner: hexId(30009),
      oldTags: [
        ['x', 'A', '~u=10;o=00000001'],
        ['x', 'B', '~u=30;o=00000002'],
        ['x', 'C', '~u=10;o=00000003']
      ],
      incomingTags: [['x', 'X'], ['x', 'A'], ['x', 'Y']]
    })

    assert.deepEqual(plainTags(tags).slice(0, 4), [
      ['x', 'X'],
      ['x', 'A'],
      ['x', 'Y'],
      ['x', 'B']
    ])
    assertContentClock(tags[4], 20)
    assertTombstoneTag(tags[5], 'zz', 'x^C', 20, [0, 1])
    assertRanksStrictlyIncreasing(tags.slice(0, 4))
  })

  it('merges replaceable fields and records deleted tags as tombstones', async () => {
    const owner = hexId(30001)
    const db = getNostrDb(owner)
    const old = event({
      id: hexId(1),
      pubkey: owner,
      kind: 30023,
      created_at: 10,
      tags: [
        ['d', 'post', '~u=10;o=00000001'],
        ['p', B, '~u=10;o=00000002'],
        ['t', 'old', '~u=10;o=00000003'],
        ['~', 'u=10']
      ],
      content: 'old'
    })
    const incoming = event({
      id: hexId(2),
      pubkey: owner,
      kind: 30023,
      created_at: 20,
      tags: [['d', 'post'], ['p', B], ['p', C]],
      content: 'new'
    })

    assertAddOk(await db.add(old))
    const result = await db.add(incoming, {
      signEvent: template => signedFromTemplate(template, { id: hexId(3), pubkey: owner })
    })

    assertAddOk(result, { code: 'replaced', stored: true, published: true })
    assert.equal(result.merged, true)

    const [stored] = await queryResults(db, { ids: [hexId(3)] })
    assert.equal(stored.content, 'new')
    assert.deepEqual(plainTags(stored.tags).slice(0, 3), [
      ['d', 'post'],
      ['p', B],
      ['p', C]
    ])
    assertContentClock(stored.tags[3], 20)
    assertTombstoneTag(stored.tags[4], 'zz', 't^old', 20, [0, 1])
  })

  it('applies tombstone naming, grace, and cap options during CRDT merge', async () => {
    await withPatchedNow(100, async () => {
      const owner = hexId(30002)
      const db = getNostrDb(owner)
      const old = event({
        id: hexId(1),
        pubkey: owner,
        kind: 30023,
        created_at: 1,
        tags: [
          ['d', 'post', '~u=1;o=00000001'],
          ['p', B, '~u=1;o=00000002'],
          ['t', 'old', '~u=2;o=00000003'],
          ['zz', 'x^gone', '~u=1;i=0,1']
        ]
      })
      const incoming = event({
        id: hexId(2),
        pubkey: owner,
        kind: 30023,
        created_at: 50,
        tags: [['d', 'post']]
      })

      assertAddOk(await db.add(old))
      await db.add(incoming, {
        signEvent: template => signedFromTemplate(template, { id: hexId(3), pubkey: owner }),
        tombstoneTagName: { byName: { p: 'z' } },
        tombstoneGraceSeconds: 10,
        maxTombstoneTags: 1
      })

      const [stored] = await queryResults(db, { ids: [hexId(3)] })
      assertTombstoneTag(stored.tags.at(-1), 'z', `p^${B}`, 50, [0, 1])
      assert.equal(stored.tags.filter(tag => tag[0] === 'z' || tag[0] === 'zz').length, 1)
    })
  })

  it('uses tag identity overrides and deterministic equal-timestamp wins', async () => {
    const owner = hexId(30003)
    const db = getNostrDb(owner)
    const old = event({
      id: hexId(1),
      pubkey: owner,
      kind: 30023,
      created_at: 10,
      tags: [
        ['d', 'post', '~u=10;o=00000001'],
        ['x', 'same', 'a', '~u=10;o=00000002'],
        ['x', 'same', 'b', '~u=10;o=00000003']
      ]
    })
    const incoming = event({
      id: hexId(2),
      pubkey: owner,
      kind: 30023,
      created_at: 10,
      tags: [['d', 'post'], ['x', 'same', 'a'], ['x', 'same', 'c', '~u=10;o=00000004']]
    })

    assertAddOk(await db.add(old))
    await db.add(incoming, {
      signEvent: template => signedFromTemplate(template, { id: hexId(3), pubkey: owner }),
      tagIdentity: { byName: { x: [0, 1, 2] } }
    })

    const [stored] = await queryResults(db, { ids: [hexId(3)] })
    assert.equal(stored.created_at, 11)
    assert.deepEqual(plainTags(stored.tags.filter(tag => tag[0] === 'x')), [
      ['x', 'same', 'a'],
      ['x', 'same', 'c']
    ])
    assertTombstoneTag(stored.tags.find(tag => tag[0] === 'zz'), 'zz', 'x^same^b', 10, [0, 1, 2])
  })

  it('converges sync merges regardless of pairwise or three-device order', () => {
    const owner = hexId(30021)
    const versionA = event({
      id: hexId(1),
      pubkey: owner,
      kind: 30023,
      created_at: 10,
      tags: [['d', 'post', '~u=10;o=00000001'], ['x', 'A', '~u=10;o=50000000']],
      content: 'A'
    })
    const versionB = event({
      id: hexId(2),
      pubkey: owner,
      kind: 30023,
      created_at: 20,
      tags: [['d', 'post', '~u=10;o=00000001'], ['x', 'B', '~u=20;o=30000000']],
      content: 'B'
    })
    const versionC = event({
      id: hexId(3),
      pubkey: owner,
      kind: 30023,
      created_at: 15,
      tags: [['d', 'post', '~u=10;o=00000001'], ['x', 'C', '~u=15;o=70000000']],
      content: 'C'
    })

    const ab = buildCrdtMergeTemplate(versionB, versionA, { mergeSource: 'sync', now: 100 })
    const ba = buildCrdtMergeTemplate(versionA, versionB, { mergeSource: 'sync', now: 999 })
    assert.deepEqual(ab, ba)

    const abc = buildCrdtMergeTemplate(versionC, ab, { mergeSource: 'sync', now: 1 })
    const bca = buildCrdtMergeTemplate(versionA, buildCrdtMergeTemplate(versionC, versionB, { mergeSource: 'sync' }), { mergeSource: 'sync' })
    assert.deepEqual(abc, bca)
    assert.deepEqual(plainTags(abc.tags).filter(tag => tag[0] === 'x'), [['x', 'B'], ['x', 'A'], ['x', 'C']])
    assert.equal(abc.created_at, 20)
  })

  it('uses explicit tombstones only in sync mode and sorts them deterministically', () => {
    const owner = hexId(30022)
    const existing = event({
      id: hexId(1),
      pubkey: owner,
      kind: 30023,
      created_at: 10,
      tags: [
        ['d', 'post', '~u=10;o=00000001'],
        ['x', 'A', '~u=10;o=20000000'],
        ['x', 'B', '~u=10;o=30000000']
      ],
      content: 'existing'
    })
    const missingOnly = event({
      id: hexId(2),
      pubkey: owner,
      kind: 30023,
      created_at: 20,
      tags: [['d', 'post', '~u=10;o=00000001']],
      content: 'missing'
    })
    const explicitDelete = event({
      id: hexId(3),
      pubkey: owner,
      kind: 30023,
      created_at: 20,
      tags: [
        ['d', 'post', '~u=10;o=00000001'],
        ['zz', 'x^B', '~u=20;i=0,1'],
        ['z', 'x^A', '~u=20;i=0,1']
      ],
      content: 'delete'
    })

    const preserved = buildCrdtMergeTemplate(missingOnly, existing, { mergeSource: 'sync' })
    assert.deepEqual(plainTags(preserved.tags).filter(tag => tag[0] === 'x'), [['x', 'A'], ['x', 'B']])

    const deleted = buildCrdtMergeTemplate(explicitDelete, existing, { mergeSource: 'sync' })
    assert.deepEqual(plainTags(deleted.tags).filter(tag => tag[0] === 'x'), [])
    assert.deepEqual(deleted.tags.slice(-2), [
      ['z', 'x^A', '~u=20;i=0,1'],
      ['zz', 'x^B', '~u=20;i=0,1']
    ])
  })

  it('caps sync CRDT clocks from event data instead of local now', () => {
    const owner = hexId(30023)
    const input = event({
      id: hexId(1),
      pubkey: owner,
      kind: 30023,
      created_at: 10,
      tags: [['d', 'post', '~u=999;o=00000001'], ['x', 'A', '~u=999;o=00000002'], ['~', 'u=999']],
      content: 'sync'
    })

    const template = buildCrdtMergeTemplate(input, null, { mergeSource: 'sync', now: 10000 })
    assertNormalTag(template.tags[0], ['d', 'post'], 70)
    assertNormalTag(template.tags[1], ['x', 'A'], 70)
    assertContentClock(template.tags[2], 70)
    assert.equal(template.created_at, 70)
  })

  it('force-replaces stale coordinate rows after a verified sync CRDT merge', async () => {
    const owner = hexId(30024)
    const db = getNostrDb(owner)
    const old = event({
      id: hexId(1),
      pubkey: owner,
      kind: 30023,
      created_at: 100,
      tags: [['d', 'post', '~u=100;o=00000001'], ['x', 'A', '~u=100;o=40000000']],
      content: 'old'
    })
    const incoming = event({
      id: hexId(2),
      pubkey: owner,
      kind: 30023,
      created_at: 90,
      tags: [['d', 'post', '~u=90;o=00000001'], ['x', 'B', '~u=90;o=30000000']],
      content: 'incoming'
    })

    assertAddOk(await db.add(old))
    const result = await db.add(incoming, {
      mergeSource: 'sync',
      signEvent: template => signedFromTemplate(template, { id: hexId(3), pubkey: owner })
    })

    assertAddOk(result, { code: 'replaced', stored: true, published: true })
    const [stored] = await queryResults(db, { ids: [hexId(3)] })
    assert.deepEqual(plainTags(stored.tags).filter(tag => tag[0] === 'x'), [['x', 'B'], ['x', 'A']])
  })

  it('falls back to original ingest when CRDT signing is invalid or ineligible', async () => {
    const owner = hexId(30004)
    const db = getNostrDb(owner)
    const input = event({
      id: hexId(1),
      pubkey: owner,
      kind: 30023,
      created_at: 10,
      tags: [['d', 'post'], ['p', B]]
    })
    const otherAuthor = event({
      id: hexId(2),
      pubkey: B,
      kind: 30023,
      created_at: 20,
      tags: [['d', 'post']]
    })
    let calls = 0

    assertAddOk(await db.add(input, {
      signEvent: template => signedFromTemplate(template, { id: hexId(3), pubkey: B })
    }), { code: 'stored', stored: true })
    assert.deepEqual((await queryResults(db, { ids: [input.id] }))[0].tags, input.tags)

    assertAddOk(await db.add(otherAuthor, {
      signEvent: () => {
        calls++
        return signedFromTemplate(otherAuthor, { id: hexId(4), pubkey: B })
      }
    }), { code: 'stored', stored: true })
    assert.equal(calls, 0)
    assert.deepEqual((await queryResults(db, { ids: [otherAuthor.id] }))[0].tags, otherAuthor.tags)
  })

  it('retries CRDT signing once if the coordinate row changes while signing', async () => {
    const owner = hexId(30005)
    const db = getNostrDb(owner)
    const old = event({
      id: hexId(1),
      pubkey: owner,
      kind: 30023,
      created_at: 10,
      tags: [['d', 'post'], ['p', B, '~u=10;o=00000002']],
      content: 'old'
    })
    const incoming = event({
      id: hexId(2),
      pubkey: owner,
      kind: 30023,
      created_at: 20,
      tags: [['d', 'post'], ['p', B]],
      content: 'incoming'
    })
    const race = event({
      id: hexId(3),
      pubkey: owner,
      kind: 30023,
      created_at: 30,
      tags: [['d', 'post'], ['p', C]],
      content: 'race'
    })
    let calls = 0

    assertAddOk(await db.add(old))
    const result = await db.add(incoming, {
      signEvent: async template => {
        calls++
        if (calls === 1) {
          assertAddOk(await db.add(race, { mergeReplaceable: false }))
        }
        return signedFromTemplate(template, { id: calls === 1 ? hexId(4) : hexId(5), pubkey: owner })
      }
    })

    assertAddOk(result, { code: 'replaced', stored: true, published: true })
    assert.equal(calls, 2)
    assert.equal(result.storedId, hexId(5))

    const [stored] = await queryResults(db, { ids: [hexId(5)] })
    assert.equal(stored.created_at, 31)
    assert.equal(stored.content, 'race')
    assert.deepEqual(plainTags(stored.tags.filter(tag => tag[0] === 'p')), [
      ['p', B],
      ['p', C]
    ])
  })

  it('logs failed add operations without logging accepted benign outcomes', async () => {
    const owner = `${OWNER}69`
    const db = getNostrDb(owner)

    resetConsoleLogs()
    assertAddNotOk(await db.add({}), { code: 'invalid' })
    assertConsoleIssue(consoleWarns, { method: 'add', ownerPubkey: owner, code: 'invalid', event: null })
    assert.equal(consoleErrors.length, 0)

    await withPatchedNow(200, async () => {
      const expired = event({
        id: '1'.repeat(64),
        created_at: 100,
        tags: [['expiration', '150']],
        content: 'private'
      })

      resetConsoleLogs()
      assertAddNotOk(await db.add(expired), { code: 'expired' })
      assertConsoleIssue(consoleWarns, {
        method: 'add',
        ownerPubkey: owner,
        code: 'expired',
        event: compactEvent(expired)
      })
    })

    const targetId = '2'.repeat(64)
    const deletion = event({ id: '3'.repeat(64), kind: 5, created_at: 10, tags: [['e', targetId]] })
    assertAddOk(await db.add(deletion))

    resetConsoleLogs()
    assertAddNotOk(await db.add(event({ id: targetId, created_at: 20 })), { code: 'blocked' })
    assertConsoleIssue(consoleWarns, {
      method: 'add',
      ownerPubkey: owner,
      code: 'blocked',
      event: compactEvent(event({ id: targetId, created_at: 20 }))
    })

    resetConsoleLogs()
    assertAddNotOk(await db.addEvent({}), { code: 'invalid' })
    assertConsoleIssue(consoleWarns, { method: 'addEvent', ownerPubkey: owner, code: 'invalid', event: null })

    const stored = event({ id: '4'.repeat(64), created_at: 30 })
    assertAddOk(await db.add(stored))
    resetConsoleLogs()
    assertAddOk(await db.add(stored), { code: 'duplicate', stored: false, published: false })
    assertNoConsoleIssues()

    const newer = event({ id: '5'.repeat(64), kind: 30023, created_at: 50, tags: [['d', 'post']] })
    const stale = event({ id: '6'.repeat(64), kind: 30023, created_at: 40, tags: [['d', 'post']] })
    assertAddOk(await db.add(newer))
    resetConsoleLogs()
    assertAddOk(await db.add(stale), { code: 'superseded', stored: false, published: false })
    assertNoConsoleIssues()

    resetConsoleLogs()
    assertAddOk(await db.add(event({ id: '7'.repeat(64), kind: 20000 })), {
      code: 'published',
      stored: false,
      published: true
    })
    assertNoConsoleIssues()

    const fake = globalThis.indexedDB.databases.get(`${NOSTRDB_PREFIX}${owner}`)
    const originalTransaction = fake.transaction
    try {
      fake.transaction = () => {
        throw new Error('boom')
      }
      resetConsoleLogs()
      assertAddNotOk(await db.add(event({ id: '8'.repeat(64), created_at: 60 })), { code: 'error' })
      assertConsoleIssue(consoleErrors, {
        method: 'add',
        ownerPubkey: owner,
        code: 'error',
        event: compactEvent(event({ id: '8'.repeat(64), created_at: 60 }))
      })
      assert.equal(consoleWarns.length, 0)
    } finally {
      fake.transaction = originalTransaction
    }

    const oldIndexedDbForTest = globalThis.indexedDB
    try {
      globalThis.indexedDB = undefined
      const unavailable = new NostrDb(`${OWNER}70`)

      resetConsoleLogs()
      assertAddNotOk(await unavailable.add(event({ id: '9'.repeat(64) })), { code: 'unavailable' })
      assertConsoleIssue(consoleErrors, {
        method: 'add',
        ownerPubkey: `${OWNER}70`,
        code: 'unavailable',
        event: compactEvent(event({ id: '9'.repeat(64) }))
      })
      unavailable.bc?.close()
    } finally {
      globalThis.indexedDB = oldIndexedDbForTest
    }
  })

  it('logs query and count errors before returning fallbacks', async () => {
    const owner = `${OWNER}71`
    const db = getNostrDb(owner)
    assertAddOk(await db.add(event({ id: '1'.repeat(64), created_at: 10 })))

    const fake = globalThis.indexedDB.databases.get(`${NOSTRDB_PREFIX}${owner}`)
    const originalTransaction = fake.transaction

    try {
      fake.transaction = () => {
        throw new Error('boom')
      }

      resetConsoleLogs()
      assert.deepEqual(await queryResults(db, { kinds: [1] }), [])
      assertConsoleIssue(consoleErrors, { method: 'query', ownerPubkey: owner, hasError: true })

      resetConsoleLogs()
      assert.equal(await db.count({ kinds: [1] }), 0)
      assertConsoleIssue(consoleErrors, { method: 'count', ownerPubkey: owner, hasError: true })
    } finally {
      fake.transaction = originalTransaction
    }
  })

  it('keeps the newest coordinate event', async () => {
    const db = getNostrDb(`${OWNER}1`)
    const old = event({ id: '1'.repeat(64), pubkey: A, kind: 30023, created_at: 10, tags: [['d', 'post']] })
    const newer = event({ id: '2'.repeat(64), pubkey: A, kind: 30023, created_at: 20, tags: [['d', 'post']] })
    const stale = event({ id: '3'.repeat(64), pubkey: A, kind: 30023, created_at: 15, tags: [['d', 'post']] })

    assertAddOk(await db.add(old))
    assertAddOk(await db.add(newer))
    assertAddOk(await db.add(stale), { code: 'superseded', stored: false, published: false })

    const results = await queryResults(db, { authors: [A], kinds: [30023], '#d': ['post'] })
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

    assertAddOk(await db.add(one))
    assertAddOk(await db.add(two))
    assertAddOk(await db.add(three))
    assertAddOk(await db.add(four))

    assert.deepEqual((await queryResults(db, { ids: [one.id, two.id], kinds: [1] })).map(e => e.id), [one.id])
    assert.deepEqual((await queryResults(db, { authors: [A] })).map(e => e.id), [four.id, two.id, one.id])
    assert.deepEqual((await queryResults(db, { kinds: [1] })).map(e => e.id), [four.id, three.id, one.id])
    assert.deepEqual((await queryResults(db, { authors: [A], kinds: [1], limit: 1 })).map(e => e.id), [four.id])
    assert.deepEqual((await queryResults(db, { '#e': ['root'] })).map(e => e.id), [three.id, one.id])
    assert.deepEqual((await queryResults(db, { '#d': ['alpha'] })).map(e => e.id), [three.id, one.id])
    assert.equal(await db.count({ kinds: [1] }), 3)
    assert.equal(await db.count({ kinds: [1], limit: 1 }), 1)
  })

  it('projects query results to ids when ids_only is true', async () => {
    const db = getNostrDb(`${OWNER}50`)
    const old = event({ id: '1'.repeat(64), pubkey: A, created_at: 10 })
    const newer = event({ id: '2'.repeat(64), pubkey: A, created_at: 20 })
    const other = event({ id: '3'.repeat(64), pubkey: B, created_at: 30 })

    assertAddOk(await db.add(old))
    assertAddOk(await db.add(newer))
    assertAddOk(await db.add(other))

    assert.deepEqual(await queryResults(db, { authors: [A], ids_only: true }), [newer.id, old.id])
    assert.deepEqual(await queryResults(db, { ids: [old.id, newer.id], ids_only: true, limit: 1 }), [newer.id])
    assert.deepEqual(await queryResults(db, { authors: [A], ids_only: true, search: 'sort:asc', limit: 1 }), [old.id])
  })

  it('derives sync anchors for stored rows and coordinate replacements', async () => {
    await withPatchedNow(100, async () => {
      const owner = `${OWNER}80`
      const db = getNostrDb(owner)
      const first = event({ id: hexId(1), created_at: 10 })
      const future = event({ id: hexId(2), created_at: 200 })
      const backfill = event({ id: hexId(3), created_at: 20 })
      const oldAddress = event({ id: hexId(4), kind: 30023, created_at: 30, tags: [['d', 'post']] })
      const newerAddress = event({ id: hexId(5), kind: 30023, created_at: 40, tags: [['d', 'post']] })
      const staleAddress = event({ id: hexId(6), kind: 30023, created_at: 35, tags: [['d', 'post']] })

      assertAddOk(await db.add(first), { code: 'stored' })
      assertAddOk(await db.add(future), { code: 'stored' })
      assertAddOk(await db.add(backfill), { code: 'stored' })

      const store = fakeStore(owner, 'events')
      assert.equal(store.records.get(eventIdIndexKey(first.id)).sa, 10000)
      assert.equal(store.records.get(eventIdIndexKey(future.id)).sa, 105000)
      assert.equal(store.records.get(eventIdIndexKey(backfill.id)).sa, 105001)

      assertAddOk(await db.add(backfill), { code: 'duplicate', stored: false })
      assert.equal(store.records.get(eventIdIndexKey(backfill.id)).sa, 105001)

      assertAddOk(await db.add(oldAddress), { code: 'stored' })
      assert.equal(store.records.get(eventIdIndexKey(oldAddress.id)).sa, 105002)
      assertAddOk(await db.add(newerAddress), { code: 'replaced' })
      assert.equal(store.records.has(eventIdIndexKey(oldAddress.id)), false)
      assert.equal(store.records.get(eventIdIndexKey(newerAddress.id)).sa, 105003)
      assertAddOk(await db.add(staleAddress), { code: 'superseded', stored: false, published: false })
      assert.equal(store.records.get(eventIdIndexKey(newerAddress.id)).sa, 105003)
    })
  })

  it('returns query wrapper metadata and supports sync-anchor ranges', async () => {
    await withPatchedNow(100, async () => {
      const db = getNostrDb(`${OWNER}81`)
      const old = event({ id: hexId(1), created_at: 10 })
      const future = event({ id: hexId(2), created_at: 200 })
      const backfill = event({ id: hexId(3), created_at: 20 })

      assertAddOk(await db.add(old))
      assertAddOk(await db.add(future))
      assertAddOk(await db.add(backfill))

      const createdAt = await db.query({ ids: [old.id, future.id], search: 'sort:asc' })
      assert.deepEqual(createdAt.results.map(event => event.id), [old.id, future.id])
      assert.deepEqual(createdAt.meta, {
        algorithm: 'created_at',
        sort: 'asc',
        scores: [10, 200],
        firstScore: 10,
        lastScore: 200
      })

      assert.deepEqual(await queryResults(db, { since: 100, until: 110 }), [])

      const syncWindow = await db.query({ since: 100000, until: 105010, search: 'algo:sync sort:asc' })
      assert.deepEqual(syncWindow.results.map(event => event.id), [future.id, backfill.id])
      assert.deepEqual(syncWindow.meta, {
        algorithm: 'sync',
        sort: 'asc',
        scores: [105000, 105001],
        firstScore: 105000,
        lastScore: 105001
      })

      assert.deepEqual(await queryResults(db, { search: 'algo:sync', ids_only: true }), [backfill.id, future.id, old.id])
      assert.deepEqual(await queryResults(db, { search: 'algo:sync sort:asc', ids_only: true }), [old.id, future.id, backfill.id])
    })
  })

  it('uses key cursors for sync ids_only time scans without fetching event values', async () => {
    const owner = `${OWNER}55`
    const db = getNostrDb(owner)
    const old = event({ id: '1'.repeat(64), created_at: 10 })
    const newer = event({ id: '2'.repeat(64), created_at: 20 })
    const outside = event({ id: '3'.repeat(64), created_at: 30 })

    assertAddOk(await db.add(old))
    assertAddOk(await db.add(newer))
    assertAddOk(await db.add(outside))

    const store = fakeStore(owner, 'events')
    store.getCount = 0
    store.openCursorCount = 0
    store.openKeyCursorCount = 0

    const result = await db.query({ since: 1000, until: 25000, ids_only: true, search: 'algo:sync sort:asc' })
    assert.deepEqual(result.results, [old.id, newer.id])
    assert.deepEqual(result.meta.scores, [10000, 20000])
    assert.equal(result.meta.algorithm, 'sync')
    assert.equal(result.meta.sort, 'asc')
    assert.equal(store.getCount, 0)
    assert.equal(store.openCursorCount, 0)
    assert.equal(store.openKeyCursorCount > 0, true)
  })

  it('uses key cursors for sync ids_only author and kind scans', async () => {
    const owner = `${OWNER}56`
    const db = getNostrDb(owner)
    const one = event({ id: '1'.repeat(64), pubkey: A, kind: 1, created_at: 10 })
    const two = event({ id: '2'.repeat(64), pubkey: A, kind: 1, created_at: 20 })
    const otherAuthor = event({ id: '3'.repeat(64), pubkey: B, kind: 1, created_at: 30 })
    const otherKind = event({ id: '4'.repeat(64), pubkey: A, kind: 7, created_at: 40 })

    assertAddOk(await db.add(one))
    assertAddOk(await db.add(two))
    assertAddOk(await db.add(otherAuthor))
    assertAddOk(await db.add(otherKind))

    const store = fakeStore(owner, 'events')
    store.getCount = 0
    store.openCursorCount = 0
    store.openKeyCursorCount = 0

    assert.deepEqual(await queryResults(db, { authors: [A], kinds: [1], ids_only: true }), [two.id, one.id])
    assert.equal(store.getCount, 0)
    assert.equal(store.openCursorCount, 0)
    assert.equal(store.openKeyCursorCount > 0, true)
  })

  it('skips excluded and expired ids in the ids_only key cursor path', async () => {
    let now = 100
    await withMutableNow(() => now, async () => {
      const owner = `${OWNER}57`
      const db = getNostrDb(owner)
      const keep = event({ id: '1'.repeat(64), created_at: 10 })
      const excluded = event({ id: '2'.repeat(64), created_at: 20 })
      const expired = event({ id: '3'.repeat(64), created_at: 30, tags: [['expiration', '200']] })

      assertAddOk(await db.add(keep))
      assertAddOk(await db.add(excluded))
      assertAddOk(await db.add(expired))

      now = 201
      const store = fakeStore(owner, 'events')
      store.getCount = 0

      assert.deepEqual(await queryResults(db, { ids_only: true, '!ids': [excluded.id] }), [keep.id])
      assert.equal(store.getCount, 0)
    })
  })

  it('projects ranked search results to ids after fuzzy ordering and limit', async () => {
    const db = getNostrDb(`${OWNER}51`)
    const exactOld = event({ id: '1'.repeat(64), created_at: 10, content: 'nostr' })
    const laterMatch = event({ id: '2'.repeat(64), created_at: 20, content: 'zzzz nostr' })

    assertAddOk(await db.add(laterMatch))
    assertAddOk(await db.add(exactOld))

    assert.deepEqual(await queryResults(db, { search: 'nostr', ids_only: true, limit: 1 }), [exactOld.id])
  })

  it('excludes ids from cursor, direct, and count queries', async () => {
    const db = getNostrDb(`${OWNER}52`)
    const one = event({ id: '1'.repeat(64), pubkey: A, created_at: 10 })
    const two = event({ id: '2'.repeat(64), pubkey: A, created_at: 20 })
    const three = event({ id: '3'.repeat(64), pubkey: A, created_at: 30 })

    assertAddOk(await db.add(one))
    assertAddOk(await db.add(two))
    assertAddOk(await db.add(three))

    assert.deepEqual((await queryResults(db, { authors: [A], '!ids': [two.id] })).map(e => e.id), [three.id, one.id])
    assert.deepEqual((await queryResults(db, { ids: [one.id, two.id, three.id], '!ids': [one.id, three.id] })).map(e => e.id), [two.id])
    assert.equal(await db.count({ authors: [A], '!ids': [one.id], limit: 10 }), 2)
  })

  it('uses key-gated full event fetching for large negative id sync filters', async () => {
    const owner = `${OWNER}58`
    const db = getNostrDb(owner)
    const events = []

    for (let i = 1; i <= 132; i++) {
      const item = event({ id: hexId(i), created_at: i })
      events.push(item)
      assertAddOk(await db.add(item))
    }

    const excluded = events.slice(0, 130).map(event => event.id)
    const store = fakeStore(owner, 'events')
    store.getCount = 0
    store.openCursorCount = 0
    store.openKeyCursorCount = 0

    assert.deepEqual(
      (await queryResults(db, { since: 1000, until: 132000, '!ids': excluded, search: 'algo:sync sort:asc' })).map(event => event.id),
      [events[130].id, events[131].id]
    )
    assert.equal(store.getCount, 2)
    assert.equal(store.openCursorCount, 0)
    assert.equal(store.openKeyCursorCount > 0, true)
  })

  it('keeps the normal cursor path for small negative id filters', async () => {
    const owner = `${OWNER}59`
    const db = getNostrDb(owner)
    const one = event({ id: '1'.repeat(64), created_at: 10 })
    const two = event({ id: '2'.repeat(64), created_at: 20 })

    assertAddOk(await db.add(one))
    assertAddOk(await db.add(two))

    const store = fakeStore(owner, 'events')
    store.openKeyCursorCount = 0

    assert.deepEqual((await queryResults(db, { '!ids': [one.id] })).map(event => event.id), [two.id])
    assert.equal(store.openKeyCursorCount, 0)
  })

  it('treats empty negative ids as a no-op and all-excluded positive ids as never matching', async () => {
    const db = getNostrDb(`${OWNER}53`)
    const one = event({ id: '1'.repeat(64), pubkey: A, created_at: 10 })
    const two = event({ id: '2'.repeat(64), pubkey: A, created_at: 20 })

    assertAddOk(await db.add(one))
    assertAddOk(await db.add(two))

    assert.deepEqual((await queryResults(db, { authors: [A], '!ids': [] })).map(e => e.id), [two.id, one.id])
    assert.deepEqual(await queryResults(db, { ids: [one.id], '!ids': [one.id] }), [])
    assert.equal(await db.count({ ids: [one.id], '!ids': [one.id] }), 0)
  })

  it('sorts direct query results before applying limit', async () => {
    const db = getNostrDb(`${OWNER}18`)
    const old = event({ id: '1'.repeat(64), created_at: 10 })
    const newer = event({ id: '2'.repeat(64), created_at: 20 })

    assertAddOk(await db.add(old))
    assertAddOk(await db.add(newer))

    assert.deepEqual((await queryResults(db, { ids: [old.id, newer.id], limit: 1 })).map(e => e.id), [newer.id])
  })

  it('sorts multi-cursor query results before applying limit', async () => {
    const db = getNostrDb(`${OWNER}19`)
    const old = event({ id: '1'.repeat(64), created_at: 10, tags: [['e', 'a']] })
    const newer = event({ id: '2'.repeat(64), created_at: 20, tags: [['e', 'b']] })

    assertAddOk(await db.add(old))
    assertAddOk(await db.add(newer))

    assert.deepEqual((await queryResults(db, { '#e': ['a', 'b'], limit: 1 })).map(e => e.id), [newer.id])
  })

  it('counts only up to the filter limit', async () => {
    const db = getNostrDb(`${OWNER}20`)

    assertAddOk(await db.add(event({ id: '1'.repeat(64), tags: [['e', 'a']] })))
    assertAddOk(await db.add(event({ id: '2'.repeat(64), tags: [['e', 'b']] })))
    assertAddOk(await db.add(event({ id: '3'.repeat(64), tags: [['e', 'b']] })))

    assert.equal(await db.count({ '#e': ['a', 'b'] }), 3)
    assert.equal(await db.count({ '#e': ['a', 'b'], limit: 2 }), 2)
  })

  it('supports NIP-91 AND tag filters with OR fallback pruning', async () => {
    const db = getNostrDb(`${OWNER}61`)
    const fullBlack = event({ id: '1'.repeat(64), created_at: 10, tags: [['t', 'meme'], ['t', 'cat'], ['t', 'black']] })
    const fullWhite = event({ id: '2'.repeat(64), created_at: 20, tags: [['t', 'meme'], ['t', 'cat'], ['t', 'white']] })
    const missingAnd = event({ id: '3'.repeat(64), created_at: 30, tags: [['t', 'meme'], ['t', 'black']] })
    const missingOr = event({ id: '4'.repeat(64), created_at: 40, tags: [['t', 'meme'], ['t', 'cat']] })

    assertAddOk(await db.add(fullBlack))
    assertAddOk(await db.add(fullWhite))
    assertAddOk(await db.add(missingAnd))
    assertAddOk(await db.add(missingOr))

    assert.deepEqual(
      (await queryResults(db, {
        kinds: [1],
        '&t': ['meme', 'cat'],
        '#t': ['meme', 'cat', 'black', 'white']
      })).map(e => e.id),
      [fullWhite.id, fullBlack.id]
    )
    assert.equal(await db.count({ '&t': ['meme', 'cat'], '#t': ['meme', 'cat', 'black', 'white'] }), 2)
  })

  it('supports pure AND tags, multiple tag names, ids_only, and search post-filtering', async () => {
    const owner = `${OWNER}62`
    const db = getNostrDb(owner)
    const match = event({ id: '1'.repeat(64), created_at: 10, tags: [['t', 'meme'], ['t', 'cat'], ['p', B]], content: 'nostr cats' })
    const newer = event({ id: '2'.repeat(64), created_at: 20, tags: [['t', 'meme'], ['t', 'cat'], ['p', B]], content: 'nostr memes' })
    const missingTag = event({ id: '3'.repeat(64), created_at: 30, tags: [['t', 'meme'], ['p', B]], content: 'nostr missing' })
    const wrongP = event({ id: '4'.repeat(64), created_at: 40, tags: [['t', 'meme'], ['t', 'cat'], ['p', C]], content: 'nostr wrong p' })

    assertAddOk(await db.add(match))
    assertAddOk(await db.add(newer))
    assertAddOk(await db.add(missingTag))
    assertAddOk(await db.add(wrongP))

    const store = fakeStore(owner, 'events')
    store.openCursorCount = 0
    store.openKeyCursorCount = 0

    assert.deepEqual((await queryResults(db, { '&t': ['meme', 'cat'], '&p': [B] })).map(e => e.id), [newer.id, match.id])
    assert.deepEqual(await queryResults(db, { '&t': ['meme', 'cat'], '&p': [B], ids_only: true }), [newer.id, match.id])
    assert.equal(store.openKeyCursorCount, 0)
    assert.equal(store.openCursorCount > 0, true)
    assert.deepEqual((await queryResults(db, { '&t': ['meme', 'cat'], '&p': [B], search: 'memes' })).map(e => e.id), [newer.id])
  })

  it('supports the search sort:asc extension', async () => {
    const db = getNostrDb(`${OWNER}21`)
    const old = event({ id: '1'.repeat(64), created_at: 10, tags: [['e', 'thread']], content: 'hello old' })
    const newer = event({ id: '2'.repeat(64), created_at: 20, tags: [['e', 'thread']], content: 'hello newer' })

    assertAddOk(await db.add(old))
    assertAddOk(await db.add(newer))

    assert.deepEqual((await queryResults(db, { kinds: [1], search: 'hello unknown:value' })).map(e => e.id), [newer.id, old.id])
    assert.deepEqual((await queryResults(db, { ids: [newer.id, old.id], search: 'sort:asc', limit: 1 })).map(e => e.id), [old.id])
    assert.deepEqual((await queryResults(db, { '#e': ['thread'], search: 'sort:asc', limit: 1 })).map(e => e.id), [old.id])
  })

  it('searches across multiple cursor ranges without pausing live cursor transactions', async () => {
    const db = getNostrDb(`${OWNER}60`)
    const old = event({ id: '1'.repeat(64), created_at: 10, tags: [['e', 'alpha']], content: 'nostr relay' })
    const newer = event({ id: '2'.repeat(64), created_at: 20, tags: [['e', 'beta']], content: 'nostr relay' })

    assertAddOk(await db.add(old))
    assertAddOk(await db.add(newer))

    assert.deepEqual((await queryResults(db, { '#e': ['alpha', 'beta'], search: 'nostr' })).map(e => e.id), [newer.id, old.id])
  })

  it('ranks fuzzy search matches before applying limit', async () => {
    const db = getNostrDb(`${OWNER}22`)
    const exactOld = event({ id: '1'.repeat(64), created_at: 10, content: 'nostr' })
    const laterMatch = event({ id: '2'.repeat(64), created_at: 20, content: 'zzzz nostr' })

    assertAddOk(await db.add(laterMatch))
    assertAddOk(await db.add(exactOld))

    assert.deepEqual((await queryResults(db, { search: 'nostr', limit: 1 })).map(e => e.id), [exactOld.id])
    assert.equal(await db.count({ search: 'nostr', limit: 1 }), 1)
  })

  it('uses sort:asc as the fuzzy search chronological tie-breaker', async () => {
    const db = getNostrDb(`${OWNER}23`)
    const old = event({ id: '1'.repeat(64), created_at: 10, content: 'nostr' })
    const newer = event({ id: '2'.repeat(64), created_at: 20, content: 'nostr' })

    assertAddOk(await db.add(old))
    assertAddOk(await db.add(newer))

    assert.deepEqual((await queryResults(db, { search: 'nostr', limit: 1 })).map(e => e.id), [newer.id])
    assert.deepEqual((await queryResults(db, { search: 'nostr sort:asc', limit: 1 })).map(e => e.id), [old.id])
  })

  it('searches profile names with autocomplete sorting', async () => {
    const db = getNostrDb(`${OWNER}24`)
    const alice = event({ id: '1'.repeat(64), pubkey: A, kind: 0, content: JSON.stringify({ name: 'Alice' }) })
    const malice = event({ id: '2'.repeat(64), pubkey: B, kind: 0, content: JSON.stringify({ name: 'Malice' }) })
    const aboutOnly = event({ id: '3'.repeat(64), pubkey: C, kind: 0, content: JSON.stringify({ name: 'Bob', about: 'Alice' }) })

    assertAddOk(await db.add(malice))
    assertAddOk(await db.add(aboutOnly))
    assertAddOk(await db.add(alice))

    assert.deepEqual((await queryResults(db, { kinds: [0], search: 'ali autocomplete:true' })).map(e => e.id), [alice.id, malice.id])
    assert.deepEqual(await queryResults(db, { kinds: [0], search: 'about' }), [])
  })

  it('searches long-form title, summary, and content fields', async () => {
    const db = getNostrDb(`${OWNER}25`)
    const title = event({ id: '1'.repeat(64), kind: 30023, tags: [['d', 'title'], ['title', 'Solar Nostr']] })
    const summary = event({ id: '2'.repeat(64), kind: 30023, tags: [['d', 'summary'], ['summary', 'Relay Guide']] })
    const content = event({ id: '3'.repeat(64), kind: 30023, tags: [['d', 'content']], content: 'Body Match' })

    assertAddOk(await db.add(title))
    assertAddOk(await db.add(summary))
    assertAddOk(await db.add(content))

    assert.deepEqual((await queryResults(db, { kinds: [30023], search: 'solar' })).map(e => e.id), [title.id])
    assert.deepEqual((await queryResults(db, { kinds: [30023], search: 'guide' })).map(e => e.id), [summary.id])
    assert.deepEqual((await queryResults(db, { kinds: [30023], search: 'body' })).map(e => e.id), [content.id])
  })

  it('supports uFuzzy negative search terms', async () => {
    const db = getNostrDb(`${OWNER}40`)
    const match = event({ id: '1'.repeat(64), content: 'nostr protocol notes' })
    const excluded = event({ id: '2'.repeat(64), content: 'nostr bitcoin bridge' })

    assertAddOk(await db.add(match))
    assertAddOk(await db.add(excluded))

    assert.deepEqual((await queryResults(db, { search: 'nostr -bitcoin' })).map(e => e.id), [match.id])
    assert.equal(await db.count({ search: 'nostr -bitcoin' }), 1)
  })

  it('counts search matches without applying query early-stop targets', async () => {
    const db = getNostrDb(`${OWNER}28`)

    for (let i = 0; i < 150; i++) {
      assertAddOk(await db.add(event({
        id: hexId(1000 + i),
        created_at: i,
        content: `nostr match ${i}`
      })))
    }

    for (let i = 0; i < 30; i++) {
      assertAddOk(await db.add(event({
        id: hexId(2000 + i),
        created_at: 200 + i,
        content: `other topic ${i}`
      })))
    }

    assert.equal(await db.count({ search: 'nostr' }), 150)
    assert.equal(await db.count({ search: 'nostr', limit: 25 }), 25)
    assert.deepEqual(
      (await queryResults(db, { search: 'nostr', limit: 5 })).map(e => e.id),
      [149, 148, 147, 146, 145].map(i => hexId(1000 + i))
    )
  })

  it('queries multiple filters as OR clauses with global dedupe and overrides', async () => {
    const db = getNostrDb(`${OWNER}3`)
    const old = event({ id: '1'.repeat(64), pubkey: A, kind: 1, created_at: 10, tags: [['t', 'alpha']], content: 'nostr old' })
    const shared = event({ id: '2'.repeat(64), pubkey: A, kind: 7, created_at: 20, tags: [['t', 'beta']], content: 'nostr shared' })
    const newest = event({ id: '3'.repeat(64), pubkey: B, kind: 1, created_at: 30, tags: [['t', 'gamma']], content: 'bitcoin newest' })

    assertAddOk(await db.add(old))
    assertAddOk(await db.add(shared))
    assertAddOk(await db.add(newest))

    assert.deepEqual(
      (await queryResults(db, [{ authors: [A] }, { kinds: [1] }])).map(event => event.id),
      [newest.id, shared.id, old.id]
    )
    assert.deepEqual(
      await queryResults(db, [{ authors: [A], ids_only: true, limit: 1 }, { kinds: [1], ids_only: false, limit: 3 }]),
      [newest.id]
    )
    assert.deepEqual(
      (await queryResults(db, [{ authors: [A], search: 'sort:asc', limit: 3 }, { kinds: [1], search: 'bitcoin' }], {
        search: 'nostr',
        limit: 2,
        ids_only: false
      })).map(event => event.id),
      [shared.id, old.id]
    )
    assert.deepEqual(
      (await queryResults(db, [{ authors: [A], search: 'nostr sort:asc', limit: 2 }, { kinds: [1], search: 'bitcoin' }])).map(event => event.id),
      [old.id, shared.id]
    )
    const store = fakeStore(`${OWNER}3`, 'events')
    store.openCursorCount = 0
    store.openKeyCursorCount = 0
    assert.deepEqual(
      await queryResults(db, [{ authors: [A] }, { kinds: [1] }], { ids_only: true, limit: 2 }),
      [newest.id, shared.id]
    )
    assert.equal(store.openCursorCount, 0)
    assert.equal(store.openKeyCursorCount > 0, true)
    assert.deepEqual(await queryResults(db, []), [])
  })

  it('counts unique matches across multiple filters with global limit and search', async () => {
    const db = getNostrDb(`${OWNER}64`)
    const one = event({ id: '1'.repeat(64), pubkey: A, kind: 1, created_at: 10, content: 'nostr one' })
    const two = event({ id: '2'.repeat(64), pubkey: A, kind: 7, created_at: 20, content: 'nostr two' })
    const three = event({ id: '3'.repeat(64), pubkey: B, kind: 1, created_at: 30, content: 'bitcoin three' })

    assertAddOk(await db.add(one))
    assertAddOk(await db.add(two))
    assertAddOk(await db.add(three))

    assert.equal(await db.count([{ authors: [A] }, { kinds: [1] }]), 3)
    assert.equal(await db.count([{ authors: [A] }, { kinds: [1] }], { limit: 2 }), 2)
    assert.equal(await db.count([{ authors: [A], search: 'nostr' }, { kinds: [1], search: 'bitcoin' }], { search: 'nostr' }), 2)
    assert.equal(await db.count([]), 0)
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

    assertAddOk(await db.add(owned))
    assertAddOk(await db.add(otherAuthor))
    assertAddOk(await db.add(deletion))

    assert.deepEqual(await queryResults(db, { ids: [owned.id] }), [])
    assert.deepEqual((await queryResults(db, { ids: [otherAuthor.id] })).map(e => e.id), [otherAuthor.id])
    assert.deepEqual((await queryResults(db, { ids: [deletion.id] })).map(e => e.id), [deletion.id])
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

    assertAddOk(await db.add(owned))
    assertAddOk(await db.add(otherAuthor))
    assertAddOk(await db.add(newer))
    assertAddOk(await db.add(deletion))

    assert.deepEqual(await queryResults(db, { authors: [A], kinds: [30023], '#d': ['post'] }), [])
    assert.deepEqual((await queryResults(db, { authors: [A], kinds: [30023], '#d': ['future'] })).map(e => e.id), [newer.id])
    assert.deepEqual((await queryResults(db, { authors: [B], kinds: [30023], '#d': ['post'] })).map(e => e.id), [otherAuthor.id])
  })

  it('canonicalizes e-tag deletions of stored addressable events to address tombstones', async () => {
    const owner = `${OWNER}91`
    const db = getNostrDb(owner)
    const target = event({ id: '1'.repeat(64), pubkey: A, kind: 30023, created_at: 10, tags: [['d', 'post']] })
    const equal = event({ id: '2'.repeat(64), pubkey: A, kind: 30023, created_at: 10, tags: [['d', 'post']] })
    const newer = event({ id: '3'.repeat(64), pubkey: A, kind: 30023, created_at: 11, tags: [['d', 'post']] })
    const deletion = event({
      id: '5'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 10,
      tags: [['a', `30023:${A}:post`], ['e', target.id]]
    })

    assertAddOk(await db.add(target))
    assertAddOk(await db.add(deletion))

    const store = fakeStore(owner, DELETIONS_STORE)
    const addressRef = deletionCoordinateRef(30023, A, 'post')
    assert.equal(store.records.has(addressRef), true)
    assert.equal(store.records.has(deletionEventRef(target.id, A)), false)
    assert.equal(store.records.get(addressRef).c.length, 1)
    assert.deepEqual(await queryResults(db, { ids: [target.id] }), [])
    assertAddNotOk(await db.add(equal), { code: 'blocked' })
    assertAddOk(await db.add(newer))
  })

  it('canonicalizes e-tag deletions of replaceable events but keeps regular e tombstones', async () => {
    const owner = `${OWNER}92`
    const db = getNostrDb(owner)
    const profile = event({ id: '1'.repeat(64), pubkey: A, kind: 0, created_at: 10, tags: [['d', 'ignored']] })
    const regular = event({ id: '2'.repeat(64), pubkey: A, kind: 1, created_at: 10 })
    const oldProfile = event({ id: '3'.repeat(64), pubkey: A, kind: 0, created_at: 10 })
    const newProfile = event({ id: '4'.repeat(64), pubkey: A, kind: 0, created_at: 11 })
    const deletion = event({
      id: '5'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 10,
      tags: [['e', profile.id], ['e', regular.id]]
    })

    assertAddOk(await db.add(profile))
    assertAddOk(await db.add(regular))
    assertAddOk(await db.add(deletion))

    const store = fakeStore(owner, DELETIONS_STORE)
    assert.equal(store.records.has(deletionCoordinateRef(0, A, '')), true)
    assert.equal(store.records.has(deletionEventRef(profile.id, A)), false)
    assert.equal(store.records.has(deletionEventRef(regular.id, A)), true)
    assert.deepEqual(await queryResults(db, { ids: [profile.id, regular.id] }), [])
    assertAddNotOk(await db.add(oldProfile), { code: 'blocked' })
    assertAddOk(await db.add(newProfile))
    assertAddNotOk(await db.add(regular), { code: 'blocked' })
  })

  it('blocks future events with durable e-tag tombstones', async () => {
    const db = getNostrDb(`${OWNER}11`)
    const targetId = '1'.repeat(64)
    const deletion = event({
      id: '5'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 2,
      tags: [['e', targetId]]
    })

    assertAddOk(await db.add(deletion))
    assertAddNotOk(await db.add(event({ id: targetId, pubkey: A, created_at: 10 })), { code: 'blocked' })
    assertAddOk(await db.add(event({ id: targetId, pubkey: B, created_at: 10 })))

    assert.deepEqual((await queryResults(db, { ids: [targetId] })).map(e => e.pubkey), [B])
  })

  it('blocks future coordinate events only up to the deletion timestamp', async () => {
    const db = getNostrDb(`${OWNER}12`)
    const deletion = event({
      id: '5'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 10,
      tags: [['a', `30023:${A}:post`]]
    })
    const old = event({ id: '1'.repeat(64), pubkey: A, kind: 30023, created_at: 10, tags: [['d', 'post']] })
    const newer = event({ id: '2'.repeat(64), pubkey: A, kind: 30023, created_at: 11, tags: [['d', 'post']] })

    assertAddOk(await db.add(deletion))
    assertAddNotOk(await db.add(old), { code: 'blocked' })
    assertAddOk(await db.add(newer))

    assert.deepEqual((await queryResults(db, { authors: [A], kinds: [30023], '#d': ['post'] })).map(e => e.id), [newer.id])
  })

  it('removes unique tombstones when a deletion request is deleted', async () => {
    const db = getNostrDb(`${OWNER}13`)
    const target = event({ id: '1'.repeat(64), pubkey: A, created_at: 5 })
    const firstDeletion = event({
      id: '5'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 6,
      tags: [['e', target.id]]
    })
    const secondDeletion = event({
      id: '6'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 7,
      tags: [['e', firstDeletion.id]]
    })

    assertAddOk(await db.add(firstDeletion))
    assertAddNotOk(await db.add(target), { code: 'blocked' })
    assertAddOk(await db.add(secondDeletion))
    assert.deepEqual(await queryResults(db, { ids: [firstDeletion.id] }), [])
    assertAddOk(await db.add(target))
    assertAddNotOk(await db.add(firstDeletion), { code: 'blocked' })
  })

  it('keeps shared tombstones when deleting one contributing deletion request', async () => {
    const db = getNostrDb(`${OWNER}14`)
    const target = event({ id: '1'.repeat(64), pubkey: A, created_at: 5 })
    const firstDeletion = event({
      id: '5'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 6,
      tags: [['e', target.id]]
    })
    const sharedDeletion = event({
      id: '6'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 7,
      tags: [['e', target.id]]
    })
    const deletingDeletion = event({
      id: '7'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 8,
      tags: [['e', firstDeletion.id]]
    })

    assertAddOk(await db.add(firstDeletion))
    assertAddOk(await db.add(sharedDeletion))
    assertAddOk(await db.add(deletingDeletion))

    assert.deepEqual(await queryResults(db, { ids: [firstDeletion.id] }), [])
    assert.deepEqual((await queryResults(db, { ids: [sharedDeletion.id] })).map(e => e.id), [sharedDeletion.id])
    assertAddNotOk(await db.add(target), { code: 'blocked' })
  })

  it('keeps tombstones shared with the deletion request being inserted', async () => {
    const db = getNostrDb(`${OWNER}15`)
    const target = event({ id: '1'.repeat(64), pubkey: A, created_at: 5 })
    const firstDeletion = event({
      id: '5'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 6,
      tags: [['e', target.id]]
    })
    const replacingDeletion = event({
      id: '6'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 7,
      tags: [['e', target.id], ['e', firstDeletion.id]]
    })

    assertAddOk(await db.add(firstDeletion))
    assertAddOk(await db.add(replacingDeletion))

    assert.deepEqual(await queryResults(db, { ids: [firstDeletion.id] }), [])
    assertAddNotOk(await db.add(target), { code: 'blocked' })
  })

  it('compacts deletion requests without recursive old-request e-tags', async () => {
    const db = getNostrDb(`${OWNER}16`)
    const targetId = '1'.repeat(64)
    const firstDeletion = event({
      id: '5'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 6,
      tags: [['e', targetId]]
    })
    const duplicateDeletion = event({
      id: '6'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 7,
      tags: [['e', targetId]]
    })
    const leftoverDeletion = event({
      id: '7'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 8,
      tags: [['a', `30023:${A}:post`]]
    })
    const signed = event({
      id: '9'.repeat(64),
      pubkey: A,
      kind: 5,
      created_at: 100,
      tags: [['e', targetId]]
    })

    assertAddOk(await db.add(firstDeletion))
    assertAddOk(await db.add(duplicateDeletion))
    assertAddOk(await db.add(leftoverDeletion))

    const result = await db.compactDeletionRequests({
      author: A,
      maxTargetRefs: 1,
      createdAt: 100,
      signEvent: template => {
        assert.equal(template.created_at, 100)
        assert.deepEqual(template.tags, [['e', targetId]])
        return { ...signed, tags: template.tags, created_at: template.created_at }
      }
    })

    assert.equal(result.compacted, true)
    assert.equal(result.created.id, signed.id)
    assert.deepEqual(result.consumed, [firstDeletion.id, duplicateDeletion.id])
    assert.deepEqual(result.targets, [['e', targetId]])
    assert.deepEqual(await queryResults(db, { ids: [firstDeletion.id, duplicateDeletion.id] }), [])
    assert.deepEqual((await queryResults(db, { ids: [leftoverDeletion.id] })).map(e => e.id), [leftoverDeletion.id])
    assertAddNotOk(await db.add(event({ id: targetId, pubkey: A, created_at: 10 })), { code: 'blocked' })
    assertAddOk(await db.add(firstDeletion))
  })

  it('compacts same-cutoff address deletions with e-only filler exactly', async () => {
    const db = getNostrDb(`${OWNER}18`)
    const firstAddress = `30023:${A}:one`
    const secondAddress = `30023:${A}:two`
    const leftoverAddress = `30023:${A}:three`
    const eventTargetId = hexId(301)
    const firstDeletion = event({
      id: hexId(101),
      pubkey: A,
      kind: 5,
      created_at: 10,
      tags: [['a', firstAddress]]
    })
    const secondDeletion = event({
      id: hexId(102),
      pubkey: A,
      kind: 5,
      created_at: 10,
      tags: [['a', secondAddress]]
    })
    const eventDeletion = event({
      id: hexId(103),
      pubkey: A,
      kind: 5,
      created_at: 50,
      tags: [['e', eventTargetId]]
    })
    const differentCutoffDeletion = event({
      id: hexId(104),
      pubkey: A,
      kind: 5,
      created_at: 20,
      tags: [['a', leftoverAddress]]
    })
    const signed = event({
      id: hexId(200),
      pubkey: A,
      kind: 5,
      created_at: 10,
      tags: []
    })
    const expectedTags = [
      ['a', firstAddress],
      ['a', secondAddress],
      ['e', eventTargetId]
    ]

    assertAddOk(await db.add(firstDeletion))
    assertAddOk(await db.add(secondDeletion))
    assertAddOk(await db.add(eventDeletion))
    assertAddOk(await db.add(differentCutoffDeletion))

    const result = await db.compactDeletionRequests({
      author: A,
      maxTargetRefs: 3,
      createdAt: 100,
      signEvent: template => {
        assert.equal(template.created_at, 10)
        assert.deepEqual(template.tags, expectedTags)
        return { ...signed, tags: template.tags, created_at: template.created_at }
      }
    })

    assert.equal(result.compacted, true)
    assert.equal(result.created.id, signed.id)
    assert.deepEqual(result.consumed, [firstDeletion.id, secondDeletion.id, eventDeletion.id])
    assert.deepEqual(result.targets, expectedTags)
    assert.deepEqual(await queryResults(db, { ids: [firstDeletion.id, secondDeletion.id, eventDeletion.id] }), [])
    assert.deepEqual((await queryResults(db, { ids: [differentCutoffDeletion.id] })).map(e => e.id), [differentCutoffDeletion.id])
    assertAddNotOk(await db.add(event({ id: hexId(401), pubkey: A, kind: 30023, created_at: 10, tags: [['d', 'one']] })), { code: 'blocked' })
    assertAddOk(await db.add(event({ id: hexId(402), pubkey: A, kind: 30023, created_at: 11, tags: [['d', 'one']] })))
    assertAddNotOk(await db.add(event({ id: eventTargetId, pubkey: A, created_at: 100 })), { code: 'blocked' })
  })

  it('defaults deletion compaction to the relay-safe 100-tag limit', async () => {
    const db = getNostrDb(`${OWNER}94`)
    const deletions = []

    for (let i = 0; i < 101; i++) {
      const deletion = event({
        id: hexId(500 + i),
        pubkey: A,
        kind: 5,
        created_at: i + 1,
        tags: [['e', hexId(1000 + i)]]
      })
      deletions.push(deletion)
      assertAddOk(await db.add(deletion))
    }

    const signed = event({
      id: hexId(900),
      pubkey: A,
      kind: 5,
      created_at: 200,
      tags: []
    })
    const result = await db.compactDeletionRequests({
      author: A,
      createdAt: 200,
      signEvent: template => {
        assert.equal(template.tags.length, 100)
        return { ...signed, tags: template.tags, created_at: template.created_at }
      }
    })

    assert.equal(result.compacted, true)
    assert.equal(result.targets.length, 100)
    assert.equal(result.consumed.length, 100)
    assert.deepEqual((await queryResults(db, { ids: [deletions[100].id] })).map(e => e.id), [deletions[100].id])
  })

  it('starts deletion compaction on a non-overlapping timer', async () => {
    const db = new NostrDb(`${OWNER}17`)
    let calls = 0
    let running = 0
    let maxRunning = 0

    db.compactDeletionRequests = async () => {
      calls++
      running++
      maxRunning = Math.max(maxRunning, running)
      await delay(20)
      running--
    }

    const abort = db.startDeletionCompaction({
      signEvent: () => event({ id: '9'.repeat(64), pubkey: A, kind: 5 }),
      intervalMs: 1,
      runImmediately: true
    })

    await delay(35)
    abort()
    const callsAfterAbort = calls
    await delay(10)

    assert.equal(maxRunning, 1)
    assert.equal(calls, callsAfterAbort)
    db.bc?.close()
  })

  it('subscribes to future matching events', async () => {
    const db = getNostrDb(`${OWNER}4`)
    const iterator = db.subscribe({ kinds: [1] })
    const next = iterator.next()
    const match = event({ id: '1'.repeat(64), kind: 1 })

    assertAddOk(await db.add(event({ id: '2'.repeat(64), kind: 7 })))
    assertAddOk(await db.add(match))

    assert.deepEqual(await subscriptionResult(next), match)
    await iterator.return()
  })

  it('delays future durable events for scheduled subscriptions', async () => {
    let now = 100.9
    await withMutableNow(() => now, async () => {
      const db = getNostrDb(`${OWNER}83`)
      const iterator = db.subscribe({ kinds: [1] }, { scheduled: true })
      const next = iterator.next()
      const future = event({ id: '1'.repeat(64), kind: 1, created_at: 103 })

      assertAddOk(await db.add(future))
      assert.equal(await settlesWithin(next, 40), false)

      now = 101
      assert.deepEqual(await subscriptionResult(next, 1000), future)
      await iterator.return()
    })
  })

  it('keeps normal subscriptions immediate for future durable events', async () => {
    await withPatchedNow(100, async () => {
      const db = getNostrDb(`${OWNER}84`)
      const iterator = db.subscribe({ kinds: [1] })
      const next = iterator.next()
      const future = event({ id: '1'.repeat(64), kind: 1, created_at: 1000 })

      assertAddOk(await db.add(future))

      assert.deepEqual(await subscriptionResult(next), future)
      await iterator.return()
    })
  })

  it('streams scheduled events immediately inside skew and for non-durable events', async () => {
    await withPatchedNow(100, async () => {
      const db = getNostrDb(`${OWNER}85`)
      const withinSkew = event({ id: '1'.repeat(64), kind: 1, created_at: 102 })
      const ephemeral = event({ id: '2'.repeat(64), kind: 20000, created_at: 1000 })
      const honorary = event({ id: '3'.repeat(64), kind: 1, created_at: 1000, tags: [['expiration', '1000']] })
      const dueIterator = db.subscribe({ kinds: [1] }, { scheduled: true })
      const ephemeralIterator = db.subscribe({ kinds: [20000] }, { scheduled: true })
      const honoraryIterator = db.subscribe({ ids: [honorary.id] }, { scheduled: true })
      const dueNext = dueIterator.next()
      const ephemeralNext = ephemeralIterator.next()
      const honoraryNext = honoraryIterator.next()

      assertAddOk(await db.add(withinSkew))
      assertAddOk(await db.add(ephemeral), { code: 'published', stored: false, published: true })
      assertAddOk(await db.add(honorary), { code: 'published', stored: false, published: true })

      assert.deepEqual(await subscriptionResult(dueNext), withinSkew)
      assert.deepEqual(await subscriptionResult(ephemeralNext), ephemeral)
      assert.deepEqual(await subscriptionResult(honoraryNext), honorary)
      await dueIterator.return()
      await ephemeralIterator.return()
      await honoraryIterator.return()
    })
  })

  it('catches already stored future events when scheduled subscriptions become due', async () => {
    let now = 100.9
    await withMutableNow(() => now, async () => {
      const db = getNostrDb(`${OWNER}86`)
      const future = event({ id: '1'.repeat(64), kind: 1, created_at: 103 })

      assertAddOk(await db.add(future))

      const iterator = db.subscribe({ kinds: [1] }, { scheduled: true })
      const next = iterator.next()
      assert.equal(await settlesWithin(next, 40), false)

      now = 101
      assert.deepEqual(await subscriptionResult(next, 1000), future)
      await iterator.return()
    })
  })

  it('does not leak replaced or deleted scheduled future events', async () => {
    let now = 100.9
    await withMutableNow(() => now, async () => {
      const replacedDb = getNostrDb(`${OWNER}87`)
      const old = event({ id: '2'.repeat(64), kind: 30023, created_at: 103, tags: [['d', 'post']] })
      const newer = event({ id: '1'.repeat(64), kind: 30023, created_at: 103, tags: [['d', 'post']] })

      assertAddOk(await replacedDb.add(old))
      const replacedIterator = replacedDb.subscribe({ kinds: [30023], '#d': ['post'] }, { scheduled: true })
      const replacedNext = replacedIterator.next()
      assertAddOk(await replacedDb.add(newer), { code: 'replaced' })

      const deletedDb = getNostrDb(`${OWNER}88`)
      const target = event({ id: '3'.repeat(64), pubkey: A, kind: 1, created_at: 103 })
      const deletion = event({ id: '4'.repeat(64), pubkey: A, kind: 5, created_at: 101, tags: [['e', target.id]] })

      assertAddOk(await deletedDb.add(target))
      const deletedIterator = deletedDb.subscribe({ ids: [target.id] }, { scheduled: true })
      const deletedNext = deletedIterator.next()
      assertAddOk(await deletedDb.add(deletion))

      now = 101
      assert.deepEqual(await subscriptionResult(replacedNext, 1000), newer)
      assert.equal(await settlesWithin(deletedNext, 200), false)
      await replacedIterator.return()
      await deletedIterator.return()
    })
  })

  it('applies scheduled delivery to complex subscription filters and limit cleanup', async () => {
    let now = 100.9
    await withMutableNow(() => now, async () => {
      const db = getNostrDb(`${OWNER}89`)
      const excluded = event({ id: '1'.repeat(64), pubkey: A, kind: 1, created_at: 103, tags: [['t', 'meme'], ['t', 'cat']], content: 'nostr excluded' })
      const match = event({ id: '2'.repeat(64), pubkey: A, kind: 1, created_at: 103, tags: [['t', 'meme'], ['t', 'cat']], content: 'nostr match' })
      const wrongSearch = event({ id: '3'.repeat(64), pubkey: A, kind: 7, created_at: 103, content: 'bitcoin' })
      const afterLimit = event({ id: '4'.repeat(64), pubkey: A, kind: 7, created_at: 104, content: 'nostr later' })
      const iterator = db.subscribe([
        { '&t': ['meme', 'cat'], '!ids': [excluded.id] },
        { kinds: [7] }
      ], {
        scheduled: true,
        ids_only: true,
        search: 'nostr',
        limit: 1
      })
      const next = iterator.next()

      assertAddOk(await db.add(excluded))
      assertAddOk(await db.add(match))
      assertAddOk(await db.add(wrongSearch))
      assertAddOk(await db.add(afterLimit))

      now = 101
      assert.deepEqual(await subscriptionResult(next, 1000), match.id)
      assert.deepEqual(await iterator.next(), { done: true })
    })
  })

  it('clears scheduled timers when subscriptions are returned', async () => {
    let now = 100.9
    await withMutableNow(() => now, async () => {
      const db = getNostrDb(`${OWNER}90`)
      const iterator = db.subscribe({ kinds: [1] }, { scheduled: true })
      const next = iterator.next()
      const future = event({ id: '1'.repeat(64), kind: 1, created_at: 103 })

      assertAddOk(await db.add(future))
      await iterator.return()
      assert.deepEqual(await next, { done: true })

      now = 101
      await delay(150)
      assert.deepEqual(await iterator.next(), { done: true })
    })
  })

  it('wraps subscription results with sync metadata', async () => {
    await withPatchedNow(100, async () => {
      const db = getNostrDb(`${OWNER}82`)
      const iterator = db.subscribe({ search: 'algo:sync sort:asc', since: 10000, until: 10000 })
      const next = iterator.next()
      const match = event({ id: '1'.repeat(64), created_at: 10 })

      assertAddOk(await db.add(match))

      assert.deepEqual(await withTimeout(next), {
        value: {
          result: match,
          meta: {
            algorithm: 'sync',
            sort: 'asc',
            score: 10000
          }
        },
        done: false
      })
      await iterator.return()
    })
  })

  it('subscribes to future fuzzy search matches', async () => {
    const db = getNostrDb(`${OWNER}26`)
    const iterator = db.subscribe({ search: 'nostr' })
    const next = iterator.next()
    const match = event({ id: '1'.repeat(64), content: 'nostr search' })

    assertAddOk(await db.add(event({ id: '2'.repeat(64), content: 'bitcoin' })))
    assertAddOk(await db.add(match))

    assert.deepEqual(await subscriptionResult(next), match)
    await iterator.return()
  })

  it('applies negative ids and ids_only to subscriptions', async () => {
    const db = getNostrDb(`${OWNER}54`)
    const excluded = event({ id: '1'.repeat(64), kind: 1 })
    const match = event({ id: '2'.repeat(64), kind: 1 })
    const iterator = db.subscribe({ kinds: [1], '!ids': [excluded.id], ids_only: true })
    const next = iterator.next()

    assertAddOk(await db.add(excluded))
    assertAddOk(await db.add(match))

    assert.deepEqual(await subscriptionResult(next), match.id)
    await iterator.return()
  })

  it('applies AND tags to subscriptions', async () => {
    const db = getNostrDb(`${OWNER}63`)
    const iterator = db.subscribe({ '&t': ['meme', 'cat'], ids_only: true })
    const next = iterator.next()
    const partial = event({ id: '1'.repeat(64), tags: [['t', 'meme']] })
    const match = event({ id: '2'.repeat(64), tags: [['t', 'meme'], ['t', 'cat']] })

    assertAddOk(await db.add(partial))
    assertAddOk(await db.add(match))

    assert.deepEqual(await subscriptionResult(next), match.id)
    await iterator.return()
  })

  it('subscribes to multiple filters with ids_only, search, and auto-close limit', async () => {
    const db = getNostrDb(`${OWNER}65`)
    const iterator = db.subscribe([{ authors: [A] }, { kinds: [7] }], {
      ids_only: true,
      search: 'nostr',
      limit: 2
    })
    const first = iterator.next()
    const second = iterator.next()

    const ignored = event({ id: '1'.repeat(64), pubkey: B, kind: 1, content: 'nostr ignored' })
    const authorMatch = event({ id: '2'.repeat(64), pubkey: A, kind: 1, content: 'nostr author' })
    const kindMatch = event({ id: '3'.repeat(64), pubkey: B, kind: 7, content: 'nostr kind' })
    const afterLimit = event({ id: '4'.repeat(64), pubkey: A, kind: 7, content: 'nostr later' })

    assertAddOk(await db.add(ignored))
    assertAddOk(await db.add(authorMatch))
    assertAddOk(await db.add(kindMatch))

    assert.deepEqual(await subscriptionResult(first), authorMatch.id)
    assert.deepEqual(await subscriptionResult(second), kindMatch.id)
    assert.deepEqual(await iterator.next(), { done: true })

    assertAddOk(await db.add(afterLimit))
    assert.deepEqual(await iterator.next(), { done: true })
  })

  it('publishes ephemeral events without storing them', async () => {
    const db = getNostrDb(`${OWNER}27`)
    const iterator = db.subscribe({ kinds: [20000] })
    const next = iterator.next()
    const ephemeral = event({ id: '1'.repeat(64), kind: 20000, created_at: 10 })

    assertAddOk(await db.add(ephemeral), { code: 'published', stored: false, published: true })

    assert.deepEqual(await subscriptionResult(next), ephemeral)
    assert.deepEqual(await queryResults(db, { ids: [ephemeral.id] }), [])
    await iterator.return()
  })

  it('publishes expiration-at-created-at events without storing them', async () => {
    await withPatchedNow(50, async () => {
      const db = getNostrDb(`${OWNER}41`)
      const iterator = db.subscribe({ kinds: [1] })
      const next = iterator.next()
      const honorary = event({
        id: '1'.repeat(64),
        created_at: 100,
        tags: [['expiration', '100']]
      })

      assertAddOk(await db.add(honorary), { code: 'published', stored: false, published: true })

      assert.deepEqual(await subscriptionResult(next), honorary)
      assert.deepEqual(await queryResults(db, { ids: [honorary.id] }), [])
      await iterator.return()
    })
  })

  it('rejects expired events without publishing or storing them', async () => {
    await withPatchedNow(200, async () => {
      const db = getNostrDb(`${OWNER}42`)
      const iterator = db.subscribe({ kinds: [1] })
      const next = iterator.next()
      const expired = event({
        id: '1'.repeat(64),
        created_at: 100,
        tags: [['expiration', '150']]
      })

      assertAddNotOk(await db.add(expired), { code: 'expired' })

      assert.equal(await settlesWithin(next), false)
      assert.deepEqual(await queryResults(db, { ids: [expired.id] }), [])
      await iterator.return()
    })
  })

  it('accepts honorary ephemeral events within the clock-skew grace period', async () => {
    const honorary = event({
      id: '1'.repeat(64),
      created_at: 100,
      tags: [['expiration', '100']]
    })

    await withPatchedNow(159, async () => {
      const db = getNostrDb(`${OWNER}67`)
      const iterator = db.subscribe({ kinds: [1] })
      const next = iterator.next()

      assertAddOk(await db.add(honorary), { code: 'published', stored: false, published: true })
      assert.deepEqual(await subscriptionResult(next), honorary)
      assert.deepEqual(await queryResults(db, { ids: [honorary.id] }), [])
      await iterator.return()
    })

    await withPatchedNow(160, async () => {
      const db = getNostrDb(`${OWNER}68`)
      const iterator = db.subscribe({ kinds: [1] })
      const next = iterator.next()

      assertAddNotOk(await db.add(honorary), { code: 'expired' })
      assert.equal(await settlesWithin(next), false)
      assert.deepEqual(await queryResults(db, { ids: [honorary.id] }), [])
      await iterator.return()
    })
  })

  it('hides persisted events after they expire before purge runs', async () => {
    let now = 100
    await withMutableNow(() => now, async () => {
      const db = getNostrDb(`${OWNER}43`)
      const expiring = event({
        id: '1'.repeat(64),
        created_at: 10,
        tags: [['expiration', '200']]
      })

      assertAddOk(await db.add(expiring))
      assert.deepEqual((await queryResults(db, { ids: [expiring.id] })).map(e => e.id), [expiring.id])

      now = 201
      assert.deepEqual(await queryResults(db, { ids: [expiring.id] }), [])
      assert.equal(await db.count({ ids: [expiring.id] }), 0)
    })
  })

  it('purges expired events through the expiration index', async () => {
    await withPatchedNow(100, async () => {
      const db = getNostrDb(`${OWNER}44`)
      const expiring = event({
        id: '1'.repeat(64),
        created_at: 10,
        tags: [['expiration', '200']]
      })
      const survivor = event({
        id: '2'.repeat(64),
        created_at: 20,
        tags: [['expiration', '300']]
      })

      assertAddOk(await db.add(expiring))
      assertAddOk(await db.add(survivor))
      assert.equal(await db.purgeExpired({ now: 250 }), 1)
      assert.deepEqual((await queryResults(db, { ids: [expiring.id, survivor.id] })).map(e => e.id), [survivor.id])
      assert.equal(await db.purgeExpired({ now: 250 }), 0)
    })
  })

  it('purges expired deletion requests and their tombstones', async () => {
    await withPatchedNow(1000, async () => {
      const db = getNostrDb(`${OWNER}45`)
      const target = event({ id: '1'.repeat(64), pubkey: A, created_at: 10 })
      const deletion = event({
        id: '2'.repeat(64),
        pubkey: A,
        kind: 5,
        created_at: 100,
        tags: [['e', target.id], ['expiration', '2000']]
      })

      assertAddOk(await db.add(deletion))
      assertAddNotOk(await db.add(target), { code: 'blocked' })
      assert.equal(await db.purgeExpired({ now: 2001 }), 1)
      assert.deepEqual(await queryResults(db, { ids: [deletion.id] }), [])
      assertAddOk(await db.add(target))
    })
  })

  it('starts expiration purge on a non-overlapping timer', async () => {
    const db = getNostrDb(`${OWNER}46`)
    let calls = 0
    let running = 0
    let maxRunning = 0

    db.purgeExpired = async () => {
      calls++
      running++
      maxRunning = Math.max(maxRunning, running)
      await delay(20)
      running--
    }

    const abort = db.startExpirationPurge({
      intervalMs: 1,
      runImmediately: true
    })

    await delay(35)
    abort()
    const callsAfterAbort = calls
    await delay(10)

    assert.equal(maxRunning, 1)
    assert.equal(calls, callsAfterAbort)
    db.bc?.close()
  })

  it('receives BroadcastChannel events from another instance', async () => {
    if (typeof BroadcastChannel !== 'function') return

    const owner = `${OWNER}5`
    const receiver = new NostrDb(owner)
    const sender = new NostrDb(owner)
    const iterator = receiver.subscribe({ kinds: [1] })
    const next = iterator.next()
    const match = event({ id: '1'.repeat(64), kind: 1 })

    assertAddOk(await sender.add(match))

    assert.deepEqual(await subscriptionResult(next), match)
    await iterator.return()
    receiver.bc.close()
    sender.bc.close()
  })

  it('treats empty arrays as never matching and parses search extensions', () => {
    assert.equal(new ParsedFilter({ ids: [] }).neverMatch, true)
    assert.equal(new ParsedFilter({ '!ids': [] }).neverMatch, false)
    assert.equal(new ParsedFilter({ '&t': [] }).neverMatch, true)
    assert.equal(new ParsedFilter({ ids: ['1'.repeat(64)], '!ids': ['1'.repeat(64)] }).neverMatch, true)
    assert.equal(new ParsedFilter({ ids_only: true }).idsOnly, true)

    const andTags = new ParsedFilter({ '&t': ['meme', 'cat'], '#t': ['meme', 'cat', 'black', 'white'] })
    assert.equal(andTags.neverMatch, false)
    assert.deepEqual(andTags.andTags, [{ name: 't', values: ['cat', 'meme'] }])
    assert.deepEqual(andTags.tags, [{ name: 't', values: ['black', 'white'] }])

    const andFallback = new ParsedFilter({ '&t': ['meme', 'cat'], '#t': ['meme', 'cat'] })
    assert.equal(andFallback.neverMatch, false)
    assert.deepEqual(andFallback.tags, [])
    assert.deepEqual(andFallback.andTags, [{ name: 't', values: ['cat', 'meme'] }])

    const ignoredAnd = new ParsedFilter({ '&topic': ['meme'] })
    assert.equal(ignoredAnd.neverMatch, false)
    assert.deepEqual(ignoredAnd.andTags, [])
    assert.equal(new ParsedFilter({ '&topic': [] }).neverMatch, false)

    const ignoredOr = new ParsedFilter({ '#topic': ['meme'] })
    assert.equal(ignoredOr.neverMatch, false)
    assert.deepEqual(ignoredOr.tags, [])
    assert.equal(new ParsedFilter({ '#topic': [] }).neverMatch, false)

    const ignored = new ParsedFilter({ search: 'hello unknown:value' })
    assert.equal(ignored.neverMatch, false)
    assert.equal(ignored.sortOld, false)
    assert.equal(ignored.autocomplete, false)
    assert.equal(ignored.searchText, 'hello')

    const ascending = new ParsedFilter({ search: 'hello sort:asc autocomplete:true unknown:value' })
    assert.equal(ascending.neverMatch, false)
    assert.equal(ascending.sortOld, true)
    assert.equal(ascending.sort, 'asc')
    assert.equal(ascending.autocomplete, true)
    assert.equal(ascending.searchText, 'hello')

    const extensionOnly = new ParsedFilter({ search: 'algo:sync sort:asc unknown:value' })
    assert.equal(extensionOnly.algorithm, 'sync')
    assert.equal(extensionOnly.sort, 'asc')
    assert.equal(extensionOnly.sortOld, true)
    assert.equal(extensionOnly.searchText, '')

    const descending = new ParsedFilter({ search: 'hello sort:desc' })
    assert.equal(descending.algorithm, 'created_at')
    assert.equal(descending.sort, 'desc')
    assert.equal(descending.sortOld, false)
    assert.equal(descending.searchText, 'hello')
  })

  it('noops when IndexedDB is unavailable', async () => {
    globalThis.indexedDB = undefined
    const db = new NostrDb(`${OWNER}6`)

    assertAddNotOk(await db.add(event({ id: '1'.repeat(64) })), { code: 'unavailable' })
    assert.deepEqual(await queryResults(db, { kinds: [1] }), [])
    assert.equal(await db.count({ kinds: [1] }), 0)
    assert.deepEqual(await db.supports(), [
      'search',
      'search:sort:asc',
      'search:sort:desc',
      'search:algo:sync',
      'search:autocomplete:true',
      'ids_only',
      '!ids',
      '&tags',
      'multi_filters',
      'subscribe:scheduled',
      'app_export'
    ])
    db.bc?.close()
  })

  it('deletes a specific owner database', async () => {
    const owner = `${OWNER}9`
    const db = getNostrDb(owner)

    assertAddOk(await db.add(event({ id: '1'.repeat(64) })))
    assert.equal(await db.count({ kinds: [1] }), 1)
    assert.equal(await deleteNostrDb(owner), true)
    assert.equal(await getNostrDb(owner).count({ kinds: [1] }), 0)
  })

  it('deletes a specific owner database through the instance API', async () => {
    const owner = `${OWNER}10`
    const db = getNostrDb(owner)

    assertAddOk(await db.add(event({ id: '1'.repeat(64) })))
    assert.equal(await db.count({ kinds: [1] }), 1)
    assert.equal(await db.deleteDb(), true)
    assert.equal(await getNostrDb(owner).count({ kinds: [1] }), 0)
  })
})

function assertAddOk (result, { code, stored, published } = {}) {
  assert.equal(result.ok, true)
  if (code !== undefined) assert.equal(result.code, code)
  if (stored !== undefined) assert.equal(result.stored, stored)
  if (published !== undefined) assert.equal(result.published, published)
  assert.equal(typeof result.message, 'string')
  assert.equal(result.message.length > 0, true)
  return result
}

function assertAddNotOk (result, { code, stored = false, published = false } = {}) {
  assert.equal(result.ok, false)
  if (code !== undefined) assert.equal(result.code, code)
  assert.equal(result.stored, stored)
  assert.equal(result.published, published)
  assert.equal(typeof result.message, 'string')
  assert.equal(result.message.length > 0, true)
  return result
}

async function queryResults (db, ...args) {
  return (await db.query(...args)).results
}

async function exportEventBatches (db, appId, options) {
  const batches = []
  for await (const batch of db.exportEventsByApp(appId, options)) batches.push(batch)
  return batches
}

async function subscriptionResult (promise, ms) {
  const next = await withTimeout(promise, ms)
  assert.equal(next.done, false)
  return next.value.result
}

function resetConsoleLogs () {
  consoleErrors = []
  consoleWarns = []
}

function assertNoConsoleIssues () {
  assert.deepEqual(consoleErrors, [])
  assert.deepEqual(consoleWarns, [])
}

function assertConsoleIssue (logs, { method, ownerPubkey, code, event, hasError = false }) {
  assert.equal(logs.length, 1)

  const [prefix, details, error] = logs[0]
  assert.equal(prefix, '[nostrdb]')
  assert.equal(details.method, method)
  assert.equal(details.ownerPubkey, ownerPubkey)
  if (code !== undefined) assert.equal(details.code, code)
  if (event !== undefined) assert.deepEqual(details.event, event)
  assert.equal('content' in (details.event ?? {}), false)
  assert.equal('tags' in (details.event ?? {}), false)
  assert.equal('sig' in (details.event ?? {}), false)
  assert.equal(error instanceof Error, hasError)
}

function assertAppRefs (stored, appIds) {
  assert.deepEqual(stored.ap, appIds.map(appIdToDbAppRef).sort(compareKeys))
}

function compactEvent (event) {
  return {
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    created_at: event.created_at
  }
}

function signedFromTemplate (template, { id, pubkey = template.pubkey }) {
  return event({
    id,
    pubkey,
    kind: template.kind,
    created_at: template.created_at,
    tags: template.tags.map(tag => [...tag]),
    content: template.content
  })
}

function cloneJson (value) {
  return JSON.parse(JSON.stringify(value))
}

function parseTestCrdtMetadata (value, { prefixed = true } = {}) {
  assert.equal(typeof value, 'string')
  const source = prefixed ? value.slice(1) : value
  const fields = Object.fromEntries(source.split(';').map(part => part.split('=')))
  if ('u' in fields) fields.u = Number(fields.u)
  if ('i' in fields) fields.i = fields.i.split(',').map(value => Number(value))
  return fields
}

function assertNormalTag (tag, expectedValues, timestamp) {
  assert.deepEqual(tag.slice(0, -1), expectedValues)
  const metadata = parseTestCrdtMetadata(tag.at(-1))
  assert.equal(metadata.u, timestamp)
  assert.match(metadata.o, /^[0-9a-z]{8}$/)
  return metadata.o
}

function assertContentClock (tag, timestamp) {
  assert.deepEqual(tag, ['~', `u=${timestamp}`])
}

function assertTombstoneTag (tag, name, encodedValues, timestamp, indexes) {
  assert.deepEqual(tag, [name, encodedValues, `~u=${timestamp};i=${indexes.join(',')}`])
}

function plainTags (tags) {
  return tags.map(tag => {
    if (tag[0] === '~') return ['~']
    return tag.filter(value => typeof value !== 'string' || !value.startsWith('~'))
  })
}

function assertRanksStrictlyIncreasing (tags) {
  let previous = ''
  for (const tag of tags) {
    const rank = parseTestCrdtMetadata(tag.at(-1)).o
    assert.equal(rank > previous, true)
    previous = rank
  }
}

async function mergedTagOrder ({ owner, oldTags, incomingTags }) {
  const db = getNostrDb(owner)
  const old = event({
    id: hexId(1),
    pubkey: owner,
    kind: 0,
    created_at: 10,
    tags: oldTags
  })
  const incoming = event({
    id: hexId(2),
    pubkey: owner,
    kind: 0,
    created_at: 20,
    tags: incomingTags
  })
  let seenTemplate

  assertAddOk(await db.add(old))
  assertAddOk(await db.add(incoming, {
    signEvent: template => {
      seenTemplate = cloneJson(template)
      return signedFromTemplate(template, { id: hexId(3), pubkey: owner })
    }
  }), { code: 'replaced', stored: true })

  return seenTemplate.tags
}

function event ({
  id,
  pubkey = A,
  kind = 1,
  // eslint-disable-next-line camelcase
  created_at = 1,
  tags = [],
  content = ''
}) {
  // eslint-disable-next-line camelcase
  return { id, pubkey, kind, created_at, tags, content, sig: SIG }
}

function withTimeout (promise, ms = 1000) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('timed out')), ms))
  ])
}

function settlesWithin (promise, ms = 20) {
  return Promise.race([
    promise.then(() => true, () => true),
    delay(ms).then(() => false)
  ])
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function fakeStore (owner, name) {
  return globalThis.indexedDB.databases.get(`${NOSTRDB_PREFIX}${owner}`).stores.get(name)
}

function createNostrDbSchema (db) {
  let store = db.createObjectStore('events', { keyPath: 'i' })
  store.createIndex(INDEX.address, 'a', { unique: true })
  store.createIndex(INDEX.app, 'ap', { multiEntry: true })
  store.createIndex(INDEX.createdAt, 'ca')
  store.createIndex(INDEX.syncAnchor, 'sa')
  store.createIndex(INDEX.expiration, 'ex')
  store.createIndex(INDEX.pubkey, ['p', 'ca'])
  store.createIndex(INDEX.kind, ['k', 'ca'])
  store.createIndex(INDEX.pubkeyKind, ['p', 'k', 'ca'])
  store.createIndex(INDEX.tag, 't', { multiEntry: true })

  store = db.createObjectStore('deletions', { keyPath: 'ref' })
  store.createIndex('byRequest', 'c', { multiEntry: true })

  db.createObjectStore(KIND_REGISTRY_STORE, { keyPath: 'key' })
}

function appNeutralKindListForTest () {
  return [...new Set(Object.values(eventKinds))]
    .filter(Number.isInteger)
    .filter(kind => kind !== eventKinds.REGULAR_CUSTOM_APP_DATA && kind !== eventKinds.CUSTOM_APP_DATA)
    .sort((a, b) => a - b)
}

async function withPatchedNow (seconds, fn) {
  return withMutableNow(() => seconds, fn)
}

async function withMutableNow (getSeconds, fn) {
  const original = Date.now
  Date.now = () => getSeconds() * 1000

  try {
    return await fn()
  } finally {
    Date.now = original
  }
}

function hexId (value) {
  return value.toString(16).padStart(64, '0')
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
    this.pending = 0
    this.completed = false
    this.completeQueued = false
  }

  objectStore (name) {
    this.assertActive()
    return new FakeObjectStore(this.db.stores.get(name), this)
  }

  abort (error) {
    if (this.completed) return
    this.error = error || new Error('transaction aborted')
    this.completed = true
    this.onabort?.()
  }

  startRequest () {
    this.assertActive()
    this.pending++
    this.completeQueued = false
  }

  finishRequest () {
    this.pending--
    this.queueComplete()
  }

  queueComplete () {
    if (this.completed || this.pending !== 0 || this.completeQueued) return

    this.completeQueued = true
    queueFakeTask(() => {
      this.completeQueued = false
      if (this.completed || this.pending !== 0) return

      this.completed = true
      this.oncomplete?.()
    })
  }

  assertActive () {
    if (this.completed) throw new Error('TransactionInactiveError')
  }
}

class FakeStoreData {
  constructor (name, keyPath) {
    this.name = name
    this.keyPath = keyPath
    this.records = new Map()
    this.indexes = new Map()
    this.indexNames = namesList(this.indexes)
    this.getCount = 0
    this.openCursorCount = 0
    this.openKeyCursorCount = 0
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
    return request(() => {
      this.data.getCount++
      return this.data.records.get(key)
    }, this.tx)
  }

  put (value) {
    return request(() => {
      const key = getByKeyPath(value, this.data.keyPath)

      for (const index of this.data.indexes.values()) {
        if (!index.options.unique) continue

        for (const indexKey of indexKeys(value, index)) {
          for (const [recordKey, record] of this.data.records) {
            if (compareKeys(recordKey, key) !== 0 && indexKeys(record, index).some(key => compareKeys(key, indexKey) === 0)) {
              throw new Error('unique index violation')
            }
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
    this.data.openCursorCount++
    return requestCursor([...this.data.records.values()].map(value => {
      const key = getByKeyPath(value, this.data.keyPath)
      return { key, primaryKey: key, value }
    }), range, direction, this.tx)
  }

  openKeyCursor (range, direction) {
    this.data.openKeyCursorCount++
    return requestCursor([...this.data.records.values()].map(value => {
      const key = getByKeyPath(value, this.data.keyPath)
      return { key, primaryKey: key }
    }), range, direction, this.tx)
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
    this.store.openCursorCount++
    return requestCursor(this.entries(), range, direction, this.tx)
  }

  openKeyCursor (range, direction) {
    this.store.openKeyCursorCount++
    return requestCursor(this.entries().map(entry => ({
      key: entry.key,
      primaryKey: entry.primaryKey
    })), range, direction, this.tx)
  }

  entries () {
    const entries = []
    for (const value of this.store.records.values()) {
      const primaryKey = getByKeyPath(value, this.store.keyPath)
      for (const key of indexKeys(value, this.index)) {
        entries.push({ key, primaryKey, value })
      }
    }
    return entries
  }
}

class FakeRequest {}

class FakeCursor {
  constructor (req, entries, index, tx) {
    this.req = req
    this.entries = entries
    this.index = index
    this.tx = tx
    this.value = entries[index].value
    this.key = entries[index].key
    this.primaryKey = entries[index].primaryKey
  }

  continue () {
    this.tx?.startRequest()
    this.index++
    queueFakeTask(() => {
      try {
        this.req.result = this.entries[this.index] ? new FakeCursor(this.req, this.entries, this.index, this.tx) : undefined
        this.req.onsuccess?.({ target: this.req })
        this.tx?.finishRequest()
      } catch (error) {
        this.req.error = error
        this.req.onerror?.({ target: this.req })
        this.tx?.abort(error)
      }
    })
  }
}

class FakeIDBKeyRange {
  static bound (lower, upper, lowerOpen = false, upperOpen = false) {
    return new FakeIDBKeyRange(lower, upper, lowerOpen, upperOpen)
  }

  static only (value) {
    return new FakeIDBKeyRange(value, value, false, false)
  }

  static upperBound (upper, open = false) {
    return new FakeIDBKeyRange(undefined, upper, true, open)
  }

  static lowerBound (lower, open = false) {
    return new FakeIDBKeyRange(lower, undefined, open, true)
  }

  constructor (lower, upper, lowerOpen, upperOpen) {
    this.lower = lower
    this.upper = upper
    this.lowerOpen = lowerOpen
    this.upperOpen = upperOpen
  }

  includes (key) {
    if (this.lower !== undefined) {
      const lower = compareKeys(key, this.lower)
      if (this.lowerOpen ? lower <= 0 : lower < 0) return false
    }

    if (this.upper !== undefined) {
      const upper = compareKeys(key, this.upper)
      if (this.upperOpen ? upper >= 0 : upper > 0) return false
    }

    return true
  }
}

function request (fn, tx) {
  const req = new FakeRequest()
  tx?.startRequest()
  queueFakeTask(() => {
    try {
      req.result = fn()
      req.onsuccess?.({ target: req })
      tx?.finishRequest()
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
  tx?.startRequest()
  queueFakeTask(() => {
    try {
      const filtered = entries
        .filter(entry => !range || range.includes(entry.key))
        .sort((a, b) => compareKeys(a.key, b.key) || compareKeys(a.primaryKey, b.primaryKey))
      if (direction === 'prev') filtered.reverse()

      req.result = filtered[0] ? new FakeCursor(req, filtered, 0, tx) : undefined
      req.onsuccess?.({ target: req })
      tx?.finishRequest()
    } catch (error) {
      req.error = error
      req.onerror?.({ target: req })
      tx?.abort(error)
    }
  })
  return req
}

function queueFakeTask (fn) {
  setImmediate(fn)
}

function indexKeys (value, index) {
  const key = getByKeyPath(value, index.keyPath)
  const keys = index.options.multiEntry && Array.isArray(key) ? key : [key]
  return keys.filter(key => key !== undefined)
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
  if (isBinaryKey(a) && isBinaryKey(b)) {
    const aBytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    const bBytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    for (let i = 0; i < Math.min(aBytes.length, bBytes.length); i++) {
      if (aBytes[i] !== bBytes[i]) return aBytes[i] - bBytes[i]
    }
    return aBytes.length - bBytes.length
  }
  if (a === b) return 0
  return a < b ? -1 : 1
}

function isBinaryKey (value) {
  return ArrayBuffer.isView(value)
}

function namesList (map) {
  return {
    contains: name => map.has(name)
  }
}
