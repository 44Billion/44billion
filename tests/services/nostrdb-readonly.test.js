import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'
import { base16ToBase62 } from 'libp2r2p/base62'
import { getPublicKey } from 'libp2r2p/key'
import { finalizeEvent } from 'libp2r2p/event'
import { assertNostrDbAccess, notifyNostrDbAccessChanged } from '#services/idb/nostrdb/access.js'
import { getNostrDb, openNostrDb, deleteNostrDb, deleteNostrDbAppData } from '#services/idb/nostrdb/index.js'

mock.module('#f', { namedExports: { setWebStorageItem: () => {} } })
globalThis.IS_DEVELOPMENT = true
globalThis.indexedDB = indexedDB
globalThis.IDBKeyRange = IDBKeyRange
const { reconcileNostrDbAccounts } = await import('#services/nostrdb-account-lifecycle.js')
const key = 'local_nostrDbPendingDeletions'
const data = new Map()
const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
const write = (storage, key, value) => value === undefined ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(value))
const options = { storage, write, lock: callback => callback() }
let serial = 30
function identity (t) {
  const secret = new Uint8Array(32).fill(serial++)
  const pubkey = getPublicKey(secret)
  const flag = `session_accountByUserPk_${base16ToBase62(pubkey, { mode: 'integer', minLength: 43 })}_isReadOnly`
  t.after(async () => { await deleteNostrDb(pubkey); data.clear() })
  return { pubkey, secret, flag }
}
const names = async () => (await indexedDB.databases()).map(db => db.name)

test('readonly access rejects all storage entrypoints without creating an owner DB', async t => {
  const { pubkey, flag } = identity(t)
  storage.setItem(flag, 'true')
  assert.throws(() => getNostrDb(pubkey), { code: 'READ_ONLY_ACCOUNT' })
  await assert.rejects(openNostrDb(pubkey), { code: 'READ_ONLY_ACCOUNT' })
  assert.equal(await deleteNostrDbAppData(pubkey, 'app'), 0)
  assert.ok(!(await names()).includes('44billion_nostrdb:' + pubkey))
})

test('becoming readonly deletes the DB, blocks retained instances and cancels pending reads', async t => {
  const { pubkey, secret } = identity(t)
  const db = getNostrDb(pubkey, { maintenance: false })
  const event = finalizeEvent({ kind: 1, created_at: 123, tags: [], content: 'stored' }, secret)
  assert.equal((await db.add(event)).ok, true)
  const stream = db.subscribe({ kinds: [1] })
  const pending = stream.next()
  const rejected = assert.rejects(pending, { code: 'READ_ONLY_ACCOUNT' })
  await reconcileNostrDbAccounts([{ pubkey, isReadOnly: true }], options)
  await rejected
  assert.ok(!(await names()).includes('44billion_nostrdb:' + pubkey))
  assert.equal(storage.getItem(key), null)
  for (const method of ['add', 'query', 'count', 'remove']) await assert.rejects(db[method](event), { code: 'READ_ONLY_ACCOUNT' })
  assert.throws(() => db.subscribe({}), { code: 'READ_ONLY_ACCOUNT' })
  await reconcileNostrDbAccounts([{ pubkey, isReadOnly: false }], options)
  await assert.rejects(db.query({}), { code: 'READ_ONLY_ACCOUNT' })
  const fresh = getNostrDb(pubkey, { maintenance: false })
  assert.equal(await fresh.count({}), 0)
})

test('failed deletion persists intent and fences a later writable transition until retry', async t => {
  const { pubkey } = identity(t)
  const errors = []
  const failure = { ...options, deleteDb: async () => false, reportError: error => errors.push(error) }
  await reconcileNostrDbAccounts([{ pubkey, isReadOnly: true }], failure)
  assert.ok(JSON.parse(storage.getItem(key))[pubkey])
  await reconcileNostrDbAccounts([{ pubkey, isReadOnly: false }], failure)
  assert.throws(() => assertNostrDbAccess(pubkey), { code: 'NOSTRDB_DELETION_PENDING' })
  const deleted = []
  await reconcileNostrDbAccounts([], { ...options, deleteDb: async owner => { deleted.push(owner); return true } })
  assert.deepEqual(deleted, [pubkey])
  assert.equal(errors.length, 2)
  assert.equal(storage.getItem(key), null)
  assert.doesNotThrow(() => assertNostrDbAccess(pubkey))
})

test('locked writable accounts can store signed public events; temporary accounts cannot open storage', async t => {
  const { pubkey, secret } = identity(t)
  const pk = base16ToBase62(pubkey, { mode: 'integer', minLength: 43 })
  storage.setItem(`session_accountByUserPk_${pk}_isLocked`, 'true')
  const db = getNostrDb(pubkey, { maintenance: false })
  assert.equal((await db.add(finalizeEvent({ kind: 1, created_at: 1, tags: [], content: '' }, secret))).ok, true)
  storage.setItem('session_defaultUserPk', JSON.stringify(pk))
  notifyNostrDbAccessChanged()
  await assert.rejects(db.count({}), { code: 'READ_ONLY_TEMPORARY_ACCOUNT' })
})

test('cleanup of absent writable storage does not create a DB', async t => {
  const { pubkey } = identity(t)
  assert.equal(await deleteNostrDbAppData(pubkey, 'app'), 0)
  const db = getNostrDb(pubkey, { maintenance: false })
  await db.purgeExpired()
  await db.pruneUnreferencedHearsays()
  await db.pruneDeletionRequests()
  await db.purgeUnclaimedAppData()
  await db.purgeChunkRoot('f'.repeat(64))
  assert.ok(!(await names()).includes('44billion_nostrdb:' + pubkey))
})

test('a pending signature cannot recreate erased storage after a rapid writable transition', async t => {
  const { pubkey, secret } = identity(t)
  const db = getNostrDb(pubkey, { maintenance: false })
  const signing = Promise.withResolvers()
  const release = Promise.withResolvers()
  await db.add(finalizeEvent({ kind: 3, created_at: 4, tags: [['p', 'a'.repeat(64)]], content: '' }, secret))
  const pending = db.add(finalizeEvent({ kind: 3, created_at: 5, tags: [['p', 'b'.repeat(64)]], content: '' }, secret), {
    signEvent: async template => { signing.resolve(); await release.promise; return finalizeEvent(template, secret) }
  })
  const rejected = assert.rejects(pending, { code: 'READ_ONLY_ACCOUNT' })
  await signing.promise
  await reconcileNostrDbAccounts([{ pubkey, isReadOnly: true }], options)
  await reconcileNostrDbAccounts([{ pubkey, isReadOnly: false }], options)
  release.resolve()
  await rejected
  assert.ok(!(await names()).includes('44billion_nostrdb:' + pubkey))
})

test('read-only deletion drops owner chunk references but preserves another owner payload', async t => {
  const first = identity(t)
  const second = identity(t)
  const { stageChunkPayload, commitChunkCopy, getChunkPayload, getOwnerChunkCopy } = await import('#services/idb/browser/queries/chunk-cache.js')
  const contentHash = 'd'.repeat(64)
  const root = 'e'.repeat(64)
  const contentBytes = Uint8Array.of(1, 2, 3)
  for (const { pubkey: owner } of [first, second]) {
    await openNostrDb(owner)
    await stageChunkPayload({ contentHash, contentBytes, owner })
    await commitChunkCopy({ owner, root, index: 0, total: 1, eventId: 'a'.repeat(64), contentHash, byteLength: 3 })
  }
  await reconcileNostrDbAccounts([{ pubkey: first.pubkey, isReadOnly: true }], options)
  assert.equal(await getOwnerChunkCopy(first.pubkey, root, 0), undefined)
  assert.ok(await getChunkPayload(contentHash, { touch: false }))
  await assert.rejects(stageChunkPayload({ contentHash, contentBytes, owner: first.pubkey }), { code: 'READ_ONLY_ACCOUNT' })
  await reconcileNostrDbAccounts([{ pubkey: second.pubkey, isReadOnly: true }], options)
  assert.equal(await getChunkPayload(contentHash, { touch: false }), null)
})

test('trusted vault methods reject readonly before DB/signing and supports stays static', async t => {
  const { pubkey, flag } = identity(t)
  const { runTrustedVaultNostrDbMethod, streamTrustedVaultNostrDbSubscription } = await import('#helpers/window-message/browser/vault-nostrdb.js')
  storage.setItem(flag, 'true')
  const never = () => assert.fail('Readonly access must not open storage or request signer')
  const params = { ownerPubkey: pubkey, getNostrDb: never, ask: never }
  for (const method of ['add', 'query', 'count', 'remove', 'addPersonalCopy', 'exportEventsByAppPage', 'addEventsForApp']) {
    await assert.rejects(runTrustedVaultNostrDbMethod({ ...params, method }), { code: 'READ_ONLY_ACCOUNT' })
  }
  assert.ok((await runTrustedVaultNostrDbMethod({ ...params, method: 'supports' })).includes('remove'))
  const replies = []
  await streamTrustedVaultNostrDbSubscription({ data: { payload: { ownerPubkey: pubkey, subscriptionId: 'readonly', filter: {} } } }, {
    ...params, subscriptionId: 'readonly', subscriptions: new Map(), reply: (event, result) => replies.push(result)
  })
  assert.equal(replies.at(-1).error.code, 'READ_ONLY_ACCOUNT')
})

test('vault export discards a page completed after the owner becomes read-only', async t => {
  const { pubkey, flag } = identity(t)
  const { runTrustedVaultNostrDbMethod } = await import('#helpers/window-message/browser/vault-nostrdb.js')
  await assert.rejects(runTrustedVaultNostrDbMethod({
    ownerPubkey: pubkey, method: 'exportEventsByAppPage', params: ['app'],
    getNostrDb: () => ({
      async * exportEventsByApp () {
        storage.setItem(flag, 'true')
        yield [{ id: 'a'.repeat(64) }]
      }
    })
  }), { code: 'READ_ONLY_ACCOUNT' })
})
