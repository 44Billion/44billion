import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { base16ToBase62 } from 'libp2r2p/base62'
import { createAppEventStoreBridge } from '../../src/helpers/window-message/browser/app-event-store.js'

const owner = '11'.repeat(32)
const peer = 'ab'.repeat(32)
const unknown = '33'.repeat(32)
const accountKey = hex => base16ToBase62(hex, { mode: 'integer', minLength: 43 })

// A controllable database stream lets tests exercise revocation while no events arrive.
function stream () {
  let pending = Promise.withResolvers()
  let closed = false
  return {
    [Symbol.asyncIterator] () { return this },
    next () { return closed ? Promise.resolve({ done: true }) : pending.promise },
    push (value) {
      const previous = pending
      pending = Promise.withResolvers()
      previous.resolve({ value, done: false })
    },
    return () {
      closed = true
      pending.resolve({ done: true })
      return Promise.resolve({ done: true })
    },
    get closed () { return closed }
  }
}

// Substitute storage and UI boundaries while using the actual permissions and bridge logic.
function fixture (overrides = {}) {
  const replies = []
  const permissions = []
  const databases = []
  const vaultCalls = []
  const accesses = []
  const streams = []
  const flags = new Map()
  const state = { members: [owner, peer] }
  const bridge = createAppEventStoreBridge({
    ownerPubkey: owner,
    appId: 'chat-app',
    getAppMetadata: async () => ({ id: 'chat-app', napp: 'app-address' }),
    readPersonaPublicKeys: () => state.members,
    readAccountFlags: userPk => flags.get(userPk) ?? { isDefaultUser: false },
    getNostrDb: (pubkey, options) => {
      databases.push({ pubkey, options })
      return {
        ownerPubkey: pubkey,
        recordCacheAccess: (...args) => accesses.push({ pubkey, args }),
        query: async (filter, options) => ({ results: [{ kind: 3, pubkey }], options }),
        count: async () => pubkey === owner ? 1 : 2,
        removeLocal: async (targets, { assertAccess }) => { assertAccess(); return { ok: true, deleted: targets.length } },
        supports: async () => ({ owner: pubkey }),
        add: async (event, options) => ({ signed: await options.signEvent(event), appId: options.appId }),
        subscribe: (filter, options) => {
          const iterator = stream()
          streams.push({ pubkey, options, iterator })
          return iterator
        }
      }
    },
    askVault: async message => { vaultCalls.push(message); return { payload: { signedBy: message.payload.pubkey } } },
    askNip07: async (askVault, pubkey) => askVault({ payload: { pubkey } }),
    requestPermission: async request => { permissions.push(request) },
    reply: (event, message) => replies.push({ event, ...message }),
    ...overrides
  })
  const request = (payload, id = 'request') => bridge.handle({ data: { id, payload } })
  return { bridge, request, state, flags, replies, permissions, databases, vaultCalls, streams, accesses }
}

describe('persona event store bridge', () => {
  it('keeps the default owner and explicitly routes peer queries, counts and signing', async () => {
    const f = fixture()
    await f.request({ method: 'query', params: [{ kinds: [3] }] })
    assert.equal(f.replies.at(-1).payload.results[0].pubkey, owner)
    assert.equal(f.accesses.length, 1)
    assert.equal(f.replies.at(-1).payload.options.deferCacheAccess, true)
    assert.equal(Object.hasOwn(f.permissions.at(-1).meta, 'accountUserPk'), false)
    await f.request({ method: 'query', userPk: peer.toUpperCase(), params: [{ kinds: [3] }, { appId: 'forged' }] })
    assert.equal(f.replies.at(-1).payload.results[0].pubkey, peer)
    assert.equal(f.replies.at(-1).payload.options.appId, 'chat-app')
    assert.equal(f.permissions.at(-1).meta.accountUserPk, peer)
    await f.request({ method: 'count', userPk: peer, params: [{ kinds: [3] }] })
    assert.equal(f.replies.at(-1).payload, 2)
    await f.request({ method: 'add', userPk: peer, params: [{ kind: 3, tags: [] }, { appId: 'forged' }] })
    assert.equal(f.replies.at(-1).payload.signed.signedBy, peer)
    assert.equal(f.replies.at(-1).payload.appId, 'chat-app')
    assert.equal(f.vaultCalls.at(-1).payload.pubkey, peer)
  })

  it('rejects invalid or unavailable targets before opening a database or requesting permission', async () => {
    const f = fixture()
    for (const userPk of [undefined, null, '', 'invalid', {}, unknown]) {
      for (const method of ['add', 'addPersonalCopy', 'query', 'count', 'supports', 'subscribe']) {
        await f.request({ method, userPk, subscriptionId: 'sub' })
        assert.equal(f.replies.at(-1).error.code, 'PUBKEY_NOT_IN_PERSONA')
      }
    }
    assert.equal(f.databases.length, 0)
    assert.equal(f.permissions.length, 0)
  })

  it('rechecks cached targets and access revoked while permission is pending', async () => {
    const permission = Promise.withResolvers()
    const f = fixture({ requestPermission: () => permission.promise })
    const pending = f.request({ method: 'query', userPk: peer, params: [{ kinds: [3] }] })
    await setImmediate()
    f.state.members = [owner]
    permission.resolve()
    await pending
    assert.equal(f.replies.at(-1).error.code, 'PUBKEY_NOT_IN_PERSONA')
    const opened = f.databases.length
    await f.request({ method: 'supports', userPk: peer })
    assert.equal(f.databases.length, opened)
    assert.equal(f.replies.at(-1).error.code, 'PUBKEY_NOT_IN_PERSONA')
  })

  it('uses the target account lock/read-only flags and leaves reads available', async () => {
    const f = fixture()
    for (const [flags, code] of [
      [{ isLocked: true }, 'VAULT_LOCKED'],
      [{ isReadOnly: true }, 'READ_ONLY_ACCOUNT'],
      [{ isDefaultUser: true }, 'READ_ONLY_TEMPORARY_ACCOUNT']
    ]) {
      f.flags.set(accountKey(peer), flags)
      await f.request({ method: 'add', userPk: peer, params: [{ kind: 3, tags: [] }] })
      assert.equal(f.replies.at(-1).error.code, code)
      await f.request({ method: 'count', userPk: peer, params: [{ kinds: [3] }] })
      assert.equal(f.replies.at(-1).payload, 2)
    }
    assert.equal(f.vaultCalls.length, 0)
    assert.equal(f.accesses.length, 0)
  })

  it('propagates permission failures without signing or returning data', async () => {
    const denied = Object.assign(new Error('Permission denied'), { code: 'DENIED' })
    const f = fixture({ requestPermission: async () => { throw denied } })
    await f.request({ method: 'query', userPk: peer, params: [{ kinds: [3] }] })
    assert.equal(f.replies.at(-1).error, denied)
    await f.request({ method: 'add', userPk: peer, params: [{ kind: 3, tags: [] }] })
    assert.equal(f.replies.at(-1).error, denied)
    assert.equal(f.vaultCalls.length, 0)
    assert.equal(f.accesses.length, 0)
  })

  it('streams only the target store and terminates idle subscriptions on persona revocation', async () => {
    const f = fixture()
    const pending = f.request({ method: 'subscribe', userPk: peer, subscriptionId: 'sub', params: [{ kinds: [3] }] })
    await setImmediate()
    assert.equal(f.streams[0].pubkey, peer)
    assert.equal(f.streams[0].options.appId, 'chat-app')
    assert.equal(f.streams[0].options.deferCacheAccess, true)
    assert.equal(f.accesses.length, 0)
    f.streams[0].iterator.push({ result: { kind: 3, pubkey: peer } })
    await setImmediate()
    assert.equal(f.replies.at(-1).payload.result.pubkey, peer)
    assert.equal(f.accesses.length, 1)
    f.state.members = [owner]
    f.bridge.revalidateSubscriptions()
    await pending
    assert.equal(f.replies.at(-1).error.code, 'PUBKEY_NOT_IN_PERSONA')
    assert.equal(f.replies.at(-1).isLast, true)
    assert.equal(f.streams[0].iterator.closed, true)
  })

  it('rechecks membership before delivering events even before a persona notification', async () => {
    const f = fixture()
    const pending = f.request({ method: 'subscribe', userPk: peer, subscriptionId: 'sub', params: [{ kinds: [3] }] })
    await setImmediate()
    f.state.members = [owner]
    f.streams[0].iterator.push({ result: { kind: 3, pubkey: peer } })
    await pending
    assert.equal(f.replies.length, 1)
    assert.equal(f.replies[0].error.code, 'PUBKEY_NOT_IN_PERSONA')
    assert.equal(f.accesses.length, 0)
    assert.equal(f.streams[0].iterator.closed, true)
  })

  it('cancels pending starts and isolates subscription IDs between documents', async () => {
    const permission = Promise.withResolvers()
    const waiting = fixture({ requestPermission: () => permission.promise })
    const pendingStart = waiting.request({ method: 'subscribe', userPk: peer, subscriptionId: 'sub', params: [{ kinds: [3] }] })
    await setImmediate()
    waiting.bridge.cancel('sub')
    permission.resolve()
    await pendingStart
    assert.equal(waiting.streams.length, 0)

    const a = fixture()
    const b = fixture()
    const payload = { method: 'subscribe', subscriptionId: 'same', params: [{ kinds: [3] }] }
    const pendingA = a.request(payload)
    const pendingB = b.request(payload)
    await setImmediate()
    a.bridge.cancel('same')
    await pendingA
    assert.equal(a.streams[0].iterator.closed, true)
    assert.equal(b.streams[0].iterator.closed, false)
    b.bridge.dispose()
    await pendingB
    assert.equal(b.streams[0].iterator.closed, true)
  })
})

it('removeLocal rejects persona revocation during permission authorization and never signs', async () => {
  const pending = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const f = fixture({ requestPermission: async () => { entered.resolve(); await pending.promise } })
  const request = f.request({ method: 'removeLocal', userPk: peer, params: [[['e', 'ab'.repeat(32)]]] })
  await entered.promise
  f.state.members = [owner]
  pending.resolve()
  await request
  assert.equal(f.replies.at(-1).error.code, 'PUBKEY_NOT_IN_PERSONA')
  assert.equal(f.vaultCalls.length, 0)
  f.bridge.dispose()
})
