import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import NMMR from 'nmmr'
import { encode } from 'libp2r2p/base93'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools'
import { buildPersonalCopyUnsignedEvent } from '#helpers/personal-copy.js'

globalThis.indexedDB = indexedDB
globalThis.IDBKeyRange = IDBKeyRange

const {
  CHUNK_GRACE_MS,
  getChunkPayloadForEvent,
  getChunkPayload,
  getChunkState,
  getOwnerChunkCopy,
  listChunkCacheOwners,
  reconcileStaleChunkPayloadStages,
  removeChunkCopy,
  removeOwnerRootCopies,
  commitChunkCopy,
  stageChunkPayload,
  subscribeChunkArrivals
} = await import('#services/idb/browser/queries/chunk-cache.js')
const {
  EVENTS_STORE,
  deleteNostrDb,
  eventIdIndexKey,
  getNostrDb,
  openNostrDb
} = await import('#services/idb/nostrdb/index.js')

const foreignSecret = new Uint8Array(32).fill(3)

async function chunkFixture (seed = 1) {
  const mmr = new NMMR()
  await mmr.append(Uint8Array.of(seed, seed + 1, seed + 2, seed + 3))
  const [chunk] = await Array.fromAsync(mmr.getChunks())
  const root = mmr.getRoot()
  const template = {
    kind: 34601,
    created_at: 123,
    tags: [
      ['d', NMMR.deriveChunkId(root, chunk.index)],
      ['mmr', String(chunk.index), String(chunk.total), encode(chunk.proof)]
    ],
    content: encode(chunk.contentBytes)
  }
  return {
    chunk,
    event: finalizeEvent(template, foreignSecret),
    root,
    template
  }
}

function ownerSigner (seed) {
  const secret = new Uint8Array(32).fill(seed)
  return {
    pubkey: getPublicKey(secret),
    signEvent: template => Promise.resolve(finalizeEvent(structuredClone(template), secret))
  }
}

function requestResult (request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function waitFor (predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Timed out waiting for IndexedDB cleanup')
}

describe('normalized global chunk cache', () => {
  it('re-signs foreign chunks, externalizes content and rehydrates exact events', async () => {
    const fixture = await chunkFixture(20)
    const owner = ownerSigner(5)
    const db = getNostrDb(owner.pubkey, { maintenance: false })
    const result = await db.add(fixture.event, { signEvent: owner.signEvent })

    assert.equal(result.ok, true)
    assert.notEqual(result.storedEvent.id, fixture.event.id)
    assert.equal(result.storedEvent.pubkey, owner.pubkey)
    assert.equal(verifyEvent(result.storedEvent), true)

    const rawDb = await openNostrDb(owner.pubkey)
    const transaction = rawDb.transaction([EVENTS_STORE], 'readonly')
    const stored = await requestResult(
      transaction.objectStore(EVENTS_STORE).get(eventIdIndexKey(result.storedEvent.id))
    )
    assert.equal(Object.hasOwn(stored.event, 'content'), false)
    assert.equal(stored.cr, fixture.root)
    assert.equal(stored.ci, 0)
    assert.equal(stored.cb, 4)

    const queried = (await db.query({ kinds: [34601] })).results[0]
    assert.equal(queried.content, fixture.template.content)
    assert.equal(queried.id, result.storedEvent.id)
    assert.equal(verifyEvent(queried), true)
    assert.deepEqual(
      (await getChunkPayloadForEvent(owner.pubkey, queried.id)).contentBytes,
      fixture.chunk.contentBytes
    )
  })

  it('accepts an exact canonical owner event without another signature', async () => {
    const fixture = await chunkFixture()
    const owner = ownerSigner(6)
    const canonical = await owner.signEvent(fixture.template)
    let calls = 0
    const result = await getNostrDb(owner.pubkey, { maintenance: false }).add(canonical, {
      signEvent: async template => {
        calls++
        return owner.signEvent(template)
      }
    })
    assert.equal(result.ok, true)
    assert.equal(calls, 0)
    assert.equal(result.storedEvent, undefined)
  })

  it('canonicalizes a non-canonical owner event and rejects invalid signatures', async () => {
    const fixture = await chunkFixture(10)
    const owner = ownerSigner(21)
    const db = getNostrDb(owner.pubkey, { maintenance: false })
    const nonCanonical = await owner.signEvent({
      ...fixture.template,
      tags: [...fixture.template.tags, ['extra', 'discard me']]
    })
    let signatures = 0
    const normalized = await db.add(nonCanonical, {
      signEvent: async template => {
        signatures++
        return owner.signEvent(template)
      }
    })
    assert.equal(normalized.ok, true)
    assert.equal(signatures, 1)
    assert.deepEqual(normalized.storedEvent.tags, fixture.template.tags)
    assert.equal(verifyEvent(normalized.storedEvent), true)

    const tampered = { ...await owner.signEvent({ ...fixture.template, created_at: 124 }), created_at: 125 }
    assert.equal((await db.add(tampered, { signEvent: owner.signEvent })).code, 'invalid')
  })

  it('fails atomically when a foreign chunk cannot be signed', async () => {
    const fixture = await chunkFixture()
    const owner = ownerSigner(7)
    const before = await getChunkState()
    const db = getNostrDb(owner.pubkey, { maintenance: false })
    const result = await db.add(fixture.event, {
      signEvent: async () => { throw new Error('vault locked') }
    })
    assert.equal(result.ok, false)
    assert.equal((await db.count({ kinds: [34601] })), 0)
    const after = await getChunkState()
    assert.equal(after.totalBytes, before.totalBytes)
    assert.equal(after.copyCount, before.copyCount)
  })

  it('converts a personal-copy chunk and never stores its wrapper', async () => {
    const fixture = await chunkFixture(30)
    const owner = ownerSigner(10)
    const obfuscate = (value, kind, scope) => Promise.resolve(`obf:${kind}:${scope}:${value}`)
    let plaintext
    const unsignedWrapper = await buildPersonalCopyUnsignedEvent({
      originalEvent: fixture.event,
      ownerPubkey: owner.pubkey,
      encrypt: async (_kind, value) => {
        plaintext = value
        return 'encrypted-chunk'
      },
      obfuscate
    })
    const wrapper = await owner.signEvent(unsignedWrapper)
    const db = getNostrDb(owner.pubkey, {
      maintenance: false,
      personalCopyDecrypt: async () => plaintext,
      personalCopyObfuscate: obfuscate
    })
    const result = await db.add(wrapper, { signEvent: owner.signEvent })

    assert.equal(result.ok, true)
    assert.equal(result.storedEvent.kind, 34601)
    assert.equal(result.storedEvent.pubkey, owner.pubkey)
    assert.equal(await db.count({ kinds: [1006] }), 0)
    assert.equal(await db.count({ kinds: [34601] }), 1)
  })

  it('persists neither wrapper nor payload when personal-copy decryption fails', async () => {
    const fixture = await chunkFixture(35)
    const owner = ownerSigner(22)
    const wrapper = await owner.signEvent(await buildPersonalCopyUnsignedEvent({
      originalEvent: fixture.event,
      ownerPubkey: owner.pubkey,
      encrypt: async () => 'encrypted-chunk',
      obfuscate: async value => `obfuscated:${value}`
    }))
    const before = await getChunkState()
    const db = getNostrDb(owner.pubkey, {
      maintenance: false,
      personalCopyDecrypt: async () => { throw new Error('vault locked') },
      personalCopyObfuscate: async value => `obfuscated:${value}`
    })

    assert.equal((await db.add(wrapper, { signEvent: owner.signEvent })).code, 'invalid')
    assert.equal(await db.count({ kinds: [1006, 34601] }), 0)
    assert.equal((await getChunkState()).totalBytes, before.totalBytes)
  })

  it('deduplicates identical payload bytes across owners', async () => {
    const fixture = await chunkFixture(40)
    const ownerA = ownerSigner(8)
    const ownerB = ownerSigner(9)
    const arrivals = []
    const unsubscribe = subscribeChunkArrivals(fixture.root, arrival => arrivals.push(arrival))
    const before = await getChunkState()
    const first = await getNostrDb(ownerA.pubkey, { maintenance: false }).add(fixture.event, { signEvent: ownerA.signEvent })
    const middle = await getChunkState()
    const second = await getNostrDb(ownerB.pubkey, { maintenance: false }).add(fixture.event, { signEvent: ownerB.signEvent })
    const after = await getChunkState()

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(middle.totalBytes - before.totalBytes, 4)
    assert.equal(after.totalBytes, middle.totalBytes)
    assert.equal(after.copyCount - before.copyCount, 2)
    assert.equal((await getOwnerChunkCopy(ownerA.pubkey, fixture.root, 0)).contentHash,
      (await getOwnerChunkCopy(ownerB.pubkey, fixture.root, 0)).contentHash)
    unsubscribe()
    assert.deepEqual(arrivals.map(arrival => arrival.newRootIndex), [true, false])
  })

  it('protects only the referenced owner copy, including references inside personal copies', async () => {
    const fixture = await chunkFixture(50)
    const ownerA = ownerSigner(11)
    const ownerB = ownerSigner(12)
    const dbA = getNostrDb(ownerA.pubkey, { maintenance: false })
    const dbB = getNostrDb(ownerB.pubkey, { maintenance: false })
    const addedA = await dbA.add(fixture.event, { signEvent: ownerA.signEvent })
    await dbB.add(fixture.event, { signEvent: ownerB.signEvent })

    let plaintext
    const reference = await ownerA.signEvent({
      kind: 35128,
      created_at: 200,
      tags: [['d', 'app'], ['r', fixture.root]],
      content: ''
    })
    const wrapper = await ownerA.signEvent(await buildPersonalCopyUnsignedEvent({
      originalEvent: reference,
      ownerPubkey: ownerA.pubkey,
      encrypt: async (_kind, value) => {
        plaintext = value
        return 'encrypted-reference'
      },
      obfuscate: async value => `obfuscated:${value}`
    }))
    const personalDbA = getNostrDb(ownerA.pubkey, {
      maintenance: false,
      personalCopyDecrypt: async () => plaintext,
      personalCopyObfuscate: async value => `obfuscated:${value}`
    })
    assert.equal((await personalDbA.add(wrapper, { signEvent: ownerA.signEvent })).ok, true)

    assert.equal(await dbA.purgeChunkRoot(fixture.root, { force: true }), 0)
    assert.equal(await dbB.purgeChunkRoot(fixture.root, { force: true }), 1)
    assert.ok(await getOwnerChunkCopy(ownerA.pubkey, fixture.root, 0))
    assert.equal(await getOwnerChunkCopy(ownerB.pubkey, fixture.root, 0), undefined)

    const deletion = await ownerA.signEvent({
      kind: 5,
      created_at: 201,
      tags: [['e', wrapper.id]],
      content: ''
    })
    assert.equal((await personalDbA.add(deletion, { signEvent: ownerA.signEvent })).ok, true)
    assert.equal(await personalDbA.purgeChunkRoot(fixture.root, { force: true }), 1)
    assert.equal(await getChunkPayloadForEvent(ownerA.pubkey, addedA.storedEvent.id), null)
  })

  it('enforces the grace period unless capacity pressure forces a purge', async () => {
    const fixture = await chunkFixture(60)
    const owner = ownerSigner(13)
    const db = getNostrDb(owner.pubkey, { maintenance: false })
    await db.add(fixture.event, { signEvent: owner.signEvent })

    assert.equal(await db.purgeChunkRoot(fixture.root), 0)
    assert.equal(await db.purgeChunkRoot(fixture.root, {
      now: Date.now() + CHUNK_GRACE_MS + 1
    }), 1)
  })

  it('tracks public references through replacement and excludes protected bytes from quota', async () => {
    const fixture = await chunkFixture(65)
    const owner = ownerSigner(15)
    const db = getNostrDb(owner.pubkey, { maintenance: false })
    const before = await getChunkState()
    await db.add(fixture.event, { signEvent: owner.signEvent })
    assert.equal((await getChunkState()).unreferencedBytes - before.unreferencedBytes, 4)

    const reference = await owner.signEvent({
      kind: 35128,
      created_at: 300,
      tags: [['d', 'quota-test'], ['r', fixture.root]],
      content: ''
    })
    await db.add(reference, { signEvent: owner.signEvent })
    await db.maintainChunks()
    assert.equal((await getChunkState()).unreferencedBytes, before.unreferencedBytes)

    const replacement = await owner.signEvent({
      kind: 35128,
      created_at: 301,
      tags: [['d', 'quota-test']],
      content: ''
    })
    await db.add(replacement, { signEvent: owner.signEvent })
    await db.maintainChunks()
    assert.equal((await getChunkState()).unreferencedBytes - before.unreferencedBytes, 4)
    await db.purgeChunkRoot(fixture.root, { force: true })
  })

  it('repairs a crash between the NostrDB commit and the global copy commit', async () => {
    const fixture = await chunkFixture(70)
    const owner = ownerSigner(14)
    const db = getNostrDb(owner.pubkey, { maintenance: false })
    const result = await db.add(fixture.event, { signEvent: owner.signEvent })
    const copy = await getOwnerChunkCopy(owner.pubkey, fixture.root, 0)

    await stageChunkPayload({
      contentHash: copy.contentHash,
      contentBytes: fixture.chunk.contentBytes
    })
    await removeChunkCopy(owner.pubkey, fixture.root, 0)
    assert.equal(await getOwnerChunkCopy(owner.pubkey, fixture.root, 0), undefined)
    assert.ok(await getChunkPayload(copy.contentHash, { touch: false }))

    await db.maintainChunks()
    const repaired = await getOwnerChunkCopy(owner.pubkey, fixture.root, 0)
    assert.equal(repaired.eventId, result.storedEvent.id)
    assert.equal(repaired.contentHash, copy.contentHash)
  })

  it('cleans abandoned payload stages incrementally while remembering their owner', async () => {
    const fixture = await chunkFixture(80)
    const owner = ownerSigner(16)
    const contentHash = (await import('@noble/hashes/sha2.js'))
      .sha256(fixture.chunk.contentBytes)
    const hash = [...contentHash].map(byte => byte.toString(16).padStart(2, '0')).join('')
    await stageChunkPayload({
      contentHash: hash,
      contentBytes: fixture.chunk.contentBytes,
      owner: owner.pubkey
    })

    assert.equal((await listChunkCacheOwners()).includes(owner.pubkey), true)
    const result = await reconcileStaleChunkPayloadStages({ before: Date.now() + 1 })
    assert.equal(result.cleaned, 1)
    assert.equal(await getChunkPayload(hash, { touch: false }), null)
  })

  it('accepts a later sync reintroduction after purge without creating a tombstone', async () => {
    const fixture = await chunkFixture(90)
    const owner = ownerSigner(17)
    const canonical = await owner.signEvent(fixture.template)
    const db = getNostrDb(owner.pubkey, { maintenance: false })

    assert.equal((await db.add(canonical, { signEvent: owner.signEvent })).code, 'stored')
    assert.equal(await db.purgeChunkRoot(fixture.root, { force: true }), 1)
    assert.equal((await db.add(canonical, { signEvent: owner.signEvent })).code, 'stored')
    assert.equal(await db.count({ kinds: [34601] }), 1)
    assert.equal(await db.purgeChunkRoot(fixture.root, { force: true }), 1)
  })

  it('cleans deletion-request payload links without deleting a newer replacement', async () => {
    const deletedFixture = await chunkFixture(100)
    const owner = ownerSigner(18)
    const db = getNostrDb(owner.pubkey, { maintenance: false })
    const added = await db.add(deletedFixture.event, { signEvent: owner.signEvent })
    const deletedId = added.storedEvent.id
    const deletion = await owner.signEvent({
      kind: 5,
      created_at: 400,
      tags: [['e', deletedId]],
      content: ''
    })
    await db.add(deletion, { signEvent: owner.signEvent })
    await waitFor(async () => !(await getOwnerChunkCopy(owner.pubkey, deletedFixture.root, 0)))
    assert.equal(await getChunkPayloadForEvent(owner.pubkey, deletedId), null)

    const replacementFixture = await chunkFixture(110)
    const first = await owner.signEvent(replacementFixture.template)
    const second = await owner.signEvent({ ...replacementFixture.template, created_at: 401 })
    await db.add(first, { signEvent: owner.signEvent })
    assert.equal((await db.add(second, { signEvent: owner.signEvent })).code, 'replaced')
    await waitFor(async () =>
      (await getOwnerChunkCopy(owner.pubkey, replacementFixture.root, 0))?.eventId === second.id
    )
    assert.equal(
      (await getOwnerChunkCopy(owner.pubkey, replacementFixture.root, 0)).eventId,
      second.id
    )
  })

  it('keeps a shared payload until the last owner database is deleted', async () => {
    const fixture = await chunkFixture(120)
    const ownerA = ownerSigner(23)
    const ownerB = ownerSigner(24)
    await getNostrDb(ownerA.pubkey, { maintenance: false }).add(fixture.event, { signEvent: ownerA.signEvent })
    await getNostrDb(ownerB.pubkey, { maintenance: false }).add(fixture.event, { signEvent: ownerB.signEvent })
    const hash = (await getOwnerChunkCopy(ownerA.pubkey, fixture.root, 0)).contentHash

    assert.equal(await deleteNostrDb(ownerA.pubkey), true)
    assert.ok(await getChunkPayload(hash, { touch: false }))
    assert.equal(await deleteNostrDb(ownerB.pubkey), true)
    assert.equal(await getChunkPayload(hash, { touch: false }), null)
  })

  it('removes roots larger than one reconciliation page in bounded batches', async () => {
    const owner = ownerSigner(25).pubkey
    const root = 'd'.repeat(64)
    const before = await getChunkState()
    for (let index = 0; index < 257; index++) {
      const contentHash = (index + 1000).toString(16).padStart(64, '0')
      const contentBytes = Uint8Array.of(index & 0xff)
      await stageChunkPayload({ contentHash, contentBytes, owner })
      await commitChunkCopy({
        owner,
        root,
        index,
        total: 257,
        eventId: (index + 1).toString(16).padStart(64, '0'),
        contentHash,
        byteLength: 1
      })
    }

    assert.equal(await removeOwnerRootCopies(owner, root), 257)
    const after = await getChunkState()
    assert.equal(after.copyCount, before.copyCount)
    assert.equal(after.totalBytes, before.totalBytes)
    assert.equal(after.unreferencedBytes, before.unreferencedBytes)
  })
})
