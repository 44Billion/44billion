import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  NostrDb,
  ParsedFilter,
  coordinateRef,
  deleteNostrDb,
  deletionCoordinateRef,
  deletionEventRef,
  eventRef,
  eventIdIndexKey,
  getNostrDb,
  isNewer,
  pubkeyIndexKey,
  toStoredRecord
} from '../../src/services/idb/nostrdb/index.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
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
    const expiring = event({ id: '5'.repeat(64), tags: [['expiration', '100']] })

    assert.equal(toStoredRecord(regular).ref, eventRef(regular.id))
    assert.equal(toStoredRecord(dTagged).ref, coordinateRef(1, A, 'room'))
    assert.equal(toStoredRecord(replaceable).ref, coordinateRef(0, A, ''))
    assert.equal(toStoredRecord(addressable).ref, coordinateRef(30023, A, 'article'))
    assert.equal(toStoredRecord(expiring, { now: 50 }).ex, 100)
    assert.equal('ex' in toStoredRecord(regular), false)
  })

  it('derives deletion refs', () => {
    const id = '1'.repeat(64)

    assert.equal(deletionEventRef(id, A), `e:${eventIdIndexKey(id)}:${pubkeyIndexKey(A)}`)
    assert.equal(deletionCoordinateRef(30023, A, 'post'), `a:${coordinateRef(30023, A, 'post').slice(2)}`)
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
    assert.equal(await db.count({ kinds: [1] }), 3)
    assert.equal(await db.count({ kinds: [1], limit: 1 }), 1)
  })

  it('sorts direct query results before applying limit', async () => {
    const db = getNostrDb(`${OWNER}18`)
    const old = event({ id: '1'.repeat(64), created_at: 10 })
    const newer = event({ id: '2'.repeat(64), created_at: 20 })

    assert.equal(await db.add(old), true)
    assert.equal(await db.add(newer), true)

    assert.deepEqual((await db.query({ ids: [old.id, newer.id], limit: 1 })).map(e => e.id), [newer.id])
  })

  it('sorts multi-cursor query results before applying limit', async () => {
    const db = getNostrDb(`${OWNER}19`)
    const old = event({ id: '1'.repeat(64), created_at: 10, tags: [['e', 'a']] })
    const newer = event({ id: '2'.repeat(64), created_at: 20, tags: [['e', 'b']] })

    assert.equal(await db.add(old), true)
    assert.equal(await db.add(newer), true)

    assert.deepEqual((await db.query({ '#e': ['a', 'b'], limit: 1 })).map(e => e.id), [newer.id])
  })

  it('counts only up to the filter limit', async () => {
    const db = getNostrDb(`${OWNER}20`)

    assert.equal(await db.add(event({ id: '1'.repeat(64), tags: [['e', 'a']] })), true)
    assert.equal(await db.add(event({ id: '2'.repeat(64), tags: [['e', 'b']] })), true)
    assert.equal(await db.add(event({ id: '3'.repeat(64), tags: [['e', 'b']] })), true)

    assert.equal(await db.count({ '#e': ['a', 'b'] }), 3)
    assert.equal(await db.count({ '#e': ['a', 'b'], limit: 2 }), 2)
  })

  it('supports the search sort:old extension', async () => {
    const db = getNostrDb(`${OWNER}21`)
    const old = event({ id: '1'.repeat(64), created_at: 10, tags: [['e', 'thread']], content: 'hello old' })
    const newer = event({ id: '2'.repeat(64), created_at: 20, tags: [['e', 'thread']], content: 'hello newer' })

    assert.equal(await db.add(old), true)
    assert.equal(await db.add(newer), true)

    assert.deepEqual((await db.query({ kinds: [1], search: 'hello unknown:value' })).map(e => e.id), [newer.id, old.id])
    assert.deepEqual((await db.query({ ids: [newer.id, old.id], search: 'sort:old', limit: 1 })).map(e => e.id), [old.id])
    assert.deepEqual((await db.query({ '#e': ['thread'], search: 'sort:old', limit: 1 })).map(e => e.id), [old.id])
  })

  it('ranks fuzzy search matches before applying limit', async () => {
    const db = getNostrDb(`${OWNER}22`)
    const exactOld = event({ id: '1'.repeat(64), created_at: 10, content: 'nostr' })
    const laterMatch = event({ id: '2'.repeat(64), created_at: 20, content: 'zzzz nostr' })

    assert.equal(await db.add(laterMatch), true)
    assert.equal(await db.add(exactOld), true)

    assert.deepEqual((await db.query({ search: 'nostr', limit: 1 })).map(e => e.id), [exactOld.id])
    assert.equal(await db.count({ search: 'nostr', limit: 1 }), 1)
  })

  it('uses sort:old as the fuzzy search chronological tie-breaker', async () => {
    const db = getNostrDb(`${OWNER}23`)
    const old = event({ id: '1'.repeat(64), created_at: 10, content: 'nostr' })
    const newer = event({ id: '2'.repeat(64), created_at: 20, content: 'nostr' })

    assert.equal(await db.add(old), true)
    assert.equal(await db.add(newer), true)

    assert.deepEqual((await db.query({ search: 'nostr', limit: 1 })).map(e => e.id), [newer.id])
    assert.deepEqual((await db.query({ search: 'nostr sort:old', limit: 1 })).map(e => e.id), [old.id])
  })

  it('searches profile names with autocomplete sorting', async () => {
    const db = getNostrDb(`${OWNER}24`)
    const alice = event({ id: '1'.repeat(64), pubkey: A, kind: 0, content: JSON.stringify({ name: 'Alice' }) })
    const malice = event({ id: '2'.repeat(64), pubkey: B, kind: 0, content: JSON.stringify({ name: 'Malice' }) })
    const aboutOnly = event({ id: '3'.repeat(64), pubkey: C, kind: 0, content: JSON.stringify({ name: 'Bob', about: 'Alice' }) })

    assert.equal(await db.add(malice), true)
    assert.equal(await db.add(aboutOnly), true)
    assert.equal(await db.add(alice), true)

    assert.deepEqual((await db.query({ kinds: [0], search: 'ali autocomplete:true' })).map(e => e.id), [alice.id, malice.id])
    assert.deepEqual(await db.query({ kinds: [0], search: 'about' }), [])
  })

  it('searches long-form title, summary, and content fields', async () => {
    const db = getNostrDb(`${OWNER}25`)
    const title = event({ id: '1'.repeat(64), kind: 30023, tags: [['d', 'title'], ['title', 'Solar Nostr']] })
    const summary = event({ id: '2'.repeat(64), kind: 30023, tags: [['d', 'summary'], ['summary', 'Relay Guide']] })
    const content = event({ id: '3'.repeat(64), kind: 30023, tags: [['d', 'content']], content: 'Body Match' })

    assert.equal(await db.add(title), true)
    assert.equal(await db.add(summary), true)
    assert.equal(await db.add(content), true)

    assert.deepEqual((await db.query({ kinds: [30023], search: 'solar' })).map(e => e.id), [title.id])
    assert.deepEqual((await db.query({ kinds: [30023], search: 'guide' })).map(e => e.id), [summary.id])
    assert.deepEqual((await db.query({ kinds: [30023], search: 'body' })).map(e => e.id), [content.id])
  })

  it('supports uFuzzy negative search terms', async () => {
    const db = getNostrDb(`${OWNER}40`)
    const match = event({ id: '1'.repeat(64), content: 'nostr protocol notes' })
    const excluded = event({ id: '2'.repeat(64), content: 'nostr bitcoin bridge' })

    assert.equal(await db.add(match), true)
    assert.equal(await db.add(excluded), true)

    assert.deepEqual((await db.query({ search: 'nostr -bitcoin' })).map(e => e.id), [match.id])
    assert.equal(await db.count({ search: 'nostr -bitcoin' }), 1)
  })

  it('counts search matches without applying query early-stop targets', async () => {
    const db = getNostrDb(`${OWNER}28`)

    for (let i = 0; i < 150; i++) {
      assert.equal(await db.add(event({
        id: hexId(1000 + i),
        created_at: i,
        content: `nostr match ${i}`
      })), true)
    }

    for (let i = 0; i < 30; i++) {
      assert.equal(await db.add(event({
        id: hexId(2000 + i),
        created_at: 200 + i,
        content: `other topic ${i}`
      })), true)
    }

    assert.equal(await db.count({ search: 'nostr' }), 150)
    assert.equal(await db.count({ search: 'nostr', limit: 25 }), 25)
    assert.deepEqual(
      (await db.query({ search: 'nostr', limit: 5 })).map(e => e.id),
      [149, 148, 147, 146, 145].map(i => hexId(1000 + i))
    )
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

    assert.equal(await db.add(deletion), true)
    assert.equal(await db.add(event({ id: targetId, pubkey: A, created_at: 10 })), false)
    assert.equal(await db.add(event({ id: targetId, pubkey: B, created_at: 10 })), true)

    assert.deepEqual((await db.query({ ids: [targetId] })).map(e => e.pubkey), [B])
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

    assert.equal(await db.add(deletion), true)
    assert.equal(await db.add(old), false)
    assert.equal(await db.add(newer), true)

    assert.deepEqual((await db.query({ authors: [A], kinds: [30023], '#d': ['post'] })).map(e => e.id), [newer.id])
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

    assert.equal(await db.add(firstDeletion), true)
    assert.equal(await db.add(target), false)
    assert.equal(await db.add(secondDeletion), true)
    assert.deepEqual(await db.query({ ids: [firstDeletion.id] }), [])
    assert.equal(await db.add(target), true)
    assert.equal(await db.add(firstDeletion), false)
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

    assert.equal(await db.add(firstDeletion), true)
    assert.equal(await db.add(sharedDeletion), true)
    assert.equal(await db.add(deletingDeletion), true)

    assert.deepEqual(await db.query({ ids: [firstDeletion.id] }), [])
    assert.deepEqual((await db.query({ ids: [sharedDeletion.id] })).map(e => e.id), [sharedDeletion.id])
    assert.equal(await db.add(target), false)
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

    assert.equal(await db.add(firstDeletion), true)
    assert.equal(await db.add(replacingDeletion), true)

    assert.deepEqual(await db.query({ ids: [firstDeletion.id] }), [])
    assert.equal(await db.add(target), false)
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

    assert.equal(await db.add(firstDeletion), true)
    assert.equal(await db.add(duplicateDeletion), true)
    assert.equal(await db.add(leftoverDeletion), true)

    const result = await db.compactDeletionRequests({
      author: A,
      maxTargetRefs: 1,
      createdAt: 100,
      sign: template => {
        assert.deepEqual(template.tags, [['e', targetId]])
        return { ...signed, tags: template.tags, created_at: template.created_at }
      }
    })

    assert.equal(result.compacted, true)
    assert.equal(result.created.id, signed.id)
    assert.deepEqual(result.consumed, [firstDeletion.id, duplicateDeletion.id])
    assert.deepEqual(result.targets, [['e', targetId]])
    assert.deepEqual(await db.query({ ids: [firstDeletion.id, duplicateDeletion.id] }), [])
    assert.deepEqual((await db.query({ ids: [leftoverDeletion.id] })).map(e => e.id), [leftoverDeletion.id])
    assert.equal(await db.add(event({ id: targetId, pubkey: A, created_at: 10 })), false)
    assert.equal(await db.add(firstDeletion), true)
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
      sign: () => event({ id: '9'.repeat(64), pubkey: A, kind: 5 }),
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

    assert.equal(await db.add(event({ id: '2'.repeat(64), kind: 7 })), true)
    assert.equal(await db.add(match), true)

    assert.deepEqual(await withTimeout(next), { value: match, done: false })
    await iterator.return()
  })

  it('subscribes to future fuzzy search matches', async () => {
    const db = getNostrDb(`${OWNER}26`)
    const iterator = db.subscribe({ search: 'nostr' })
    const next = iterator.next()
    const match = event({ id: '1'.repeat(64), content: 'nostr search' })

    assert.equal(await db.add(event({ id: '2'.repeat(64), content: 'bitcoin' })), true)
    assert.equal(await db.add(match), true)

    assert.deepEqual(await withTimeout(next), { value: match, done: false })
    await iterator.return()
  })

  it('publishes ephemeral events without storing them', async () => {
    const db = getNostrDb(`${OWNER}27`)
    const iterator = db.subscribe({ kinds: [20000] })
    const next = iterator.next()
    const ephemeral = event({ id: '1'.repeat(64), kind: 20000, created_at: 10 })

    assert.equal(await db.add(ephemeral), false)

    assert.deepEqual(await withTimeout(next), { value: ephemeral, done: false })
    assert.deepEqual(await db.query({ ids: [ephemeral.id] }), [])
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

      assert.equal(await db.add(honorary), false)

      assert.deepEqual(await withTimeout(next), { value: honorary, done: false })
      assert.deepEqual(await db.query({ ids: [honorary.id] }), [])
      await iterator.return()
    })
  })

  it('publishes expired events without storing them', async () => {
    await withPatchedNow(200, async () => {
      const db = getNostrDb(`${OWNER}42`)
      const iterator = db.subscribe({ kinds: [1] })
      const next = iterator.next()
      const expired = event({
        id: '1'.repeat(64),
        created_at: 100,
        tags: [['expiration', '150']]
      })

      assert.equal(await db.add(expired), false)

      assert.deepEqual(await withTimeout(next), { value: expired, done: false })
      assert.deepEqual(await db.query({ ids: [expired.id] }), [])
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

      assert.equal(await db.add(expiring), true)
      assert.deepEqual((await db.query({ ids: [expiring.id] })).map(e => e.id), [expiring.id])

      now = 201
      assert.deepEqual(await db.query({ ids: [expiring.id] }), [])
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

      assert.equal(await db.add(expiring), true)
      assert.equal(await db.add(survivor), true)
      assert.equal(await db.purgeExpired({ now: 250 }), 1)
      assert.deepEqual((await db.query({ ids: [expiring.id, survivor.id] })).map(e => e.id), [survivor.id])
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

      assert.equal(await db.add(deletion), true)
      assert.equal(await db.add(target), false)
      assert.equal(await db.purgeExpired({ now: 2001 }), 1)
      assert.deepEqual(await db.query({ ids: [deletion.id] }), [])
      assert.equal(await db.add(target), true)
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

    assert.equal(await sender.add(match), true)

    assert.deepEqual(await withTimeout(next), { value: match, done: false })
    await iterator.return()
    receiver.bc.close()
    sender.bc.close()
  })

  it('treats empty arrays as never matching and parses search extensions', () => {
    assert.equal(new ParsedFilter({ ids: [] }).neverMatch, true)

    const ignored = new ParsedFilter({ search: 'hello unknown:value' })
    assert.equal(ignored.neverMatch, false)
    assert.equal(ignored.sortOld, false)
    assert.equal(ignored.autocomplete, false)
    assert.equal(ignored.searchText, 'hello')

    const oldest = new ParsedFilter({ search: 'hello sort:old autocomplete:true unknown:value' })
    assert.equal(oldest.neverMatch, false)
    assert.equal(oldest.sortOld, true)
    assert.equal(oldest.autocomplete, true)
    assert.equal(oldest.searchText, 'hello')

    const extensionOnly = new ParsedFilter({ search: 'sort:old unknown:value' })
    assert.equal(extensionOnly.sortOld, true)
    assert.equal(extensionOnly.searchText, '')
  })

  it('noops when IndexedDB is unavailable', async () => {
    globalThis.indexedDB = undefined
    const db = new NostrDb(`${OWNER}6`)

    assert.equal(await db.add(event({ id: '1'.repeat(64) })), false)
    assert.deepEqual(await db.query({ kinds: [1] }), [])
    assert.equal(await db.count({ kinds: [1] }), 0)
    assert.deepEqual(await db.supports(), ['search'])
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

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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
      for (const item of keys) {
        if (item === undefined) continue
        entries.push({ key: item, value })
      }
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
  static bound (lower, upper, lowerOpen = false, upperOpen = false) {
    return new FakeIDBKeyRange(lower, upper, lowerOpen, upperOpen)
  }

  static only (value) {
    return new FakeIDBKeyRange(value, value, false, false)
  }

  static upperBound (upper, open = false) {
    return new FakeIDBKeyRange(undefined, upper, true, open)
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
