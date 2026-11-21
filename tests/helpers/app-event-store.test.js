import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { base16ToBase62 } from 'libp2r2p/base62'
import { notifyNostrDbAccessChanged } from '../../src/services/idb/nostrdb/access.js'
import { createAppEventStoreBridge } from '../../src/helpers/window-message/browser/app-event-store.js'
import { ONE_TIME_DELETE_PERMISSION } from '../../src/helpers/window-message/browser/event-permissions.js'

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

function manualTimers () {
  const scheduled = []
  return {
    scheduled,
    now: () => 1_000,
    setTimer (callback, delay) {
      const timer = { callback, delay, cancelled: false, unref () {} }
      scheduled.push(timer)
      return timer
    },
    clearTimer (timer) {
      if (timer) timer.cancelled = true
    },
    fire (timer) {
      if (!timer.cancelled) timer.callback()
    },
    active () {
      return scheduled.filter(timer => !timer.cancelled)
    }
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
        remove: async (targets, { assertAccess }) => { assertAccess(); return { ok: true, deleted: targets.length } },
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
    assert.equal(f.permissions.length, 0)
    await f.request({ method: 'query', userPk: peer.toUpperCase(), params: [{ kinds: [3] }, { appId: 'forged' }] })
    assert.equal(f.replies.at(-1).payload.results[0].pubkey, peer)
    assert.equal(f.replies.at(-1).payload.options.appId, 'chat-app')
    await f.request({ method: 'count', userPk: peer, params: [{ kinds: [3] }] })
    assert.equal(f.replies.at(-1).payload, 2)
    await f.request({ method: 'add', userPk: peer, params: [{ kind: 3, tags: [] }, { appId: 'forged' }] })
    assert.equal(f.replies.at(-1).payload.signed.signedBy, peer)
    assert.equal(f.replies.at(-1).payload.appId, 'chat-app')
    assert.equal(f.vaultCalls.at(-1).payload.pubkey, peer)
    assert.equal(f.permissions.length, 0)
    await f.request({ method: 'remove', userPk: peer, params: [[['e', 'ab'.repeat(32)]]] })
    assert.equal(f.permissions.at(-1).name, ONE_TIME_DELETE_PERMISSION)
    assert.equal(f.permissions.at(-1).meta.accountUserPk, peer)
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
    const pending = f.request({ method: 'remove', userPk: peer, params: [[['e', 'ab'.repeat(32)]]] })
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

  it('blocks readonly storage but leaves locked-account reads available', async () => {
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
      if (flags.isLocked) assert.equal(f.replies.at(-1).payload, 2)
      else assert.equal(f.replies.at(-1).error.code, code)
    }
    assert.equal(f.vaultCalls.length, 0)
    assert.equal(f.accesses.length, 0)
  })

  it('propagates permission failures without signing or returning data', async () => {
    const denied = Object.assign(new Error('Permission denied'), { code: 'DENIED' })
    const f = fixture({ requestPermission: async () => { throw denied } })
    await f.request({ method: 'remove', userPk: peer, params: [[['e', 'ab'.repeat(32)]]] })
    assert.equal(f.replies.at(-1).error, denied)
    assert.equal(f.vaultCalls.length, 0)
    assert.equal(f.accesses.length, 0)
  })

  it('cancels a pending permission request without opening the database', async () => {
    let permissionSignal
    const prompted = Promise.withResolvers()
    const f = fixture({
      requestPermission: request => {
        permissionSignal = request.signal
        prompted.resolve()
        return new Promise((resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        })
      }
    })
    const pending = f.bridge.handle({
      data: {
        reqId: 'permission-cancel',
        payload: { method: 'remove', userPk: peer, params: [[['e', 'ab'.repeat(32)]]] }
      }
    })
    await prompted.promise
    assert.equal(permissionSignal instanceof AbortSignal, true)
    f.bridge.cancel({ requestId: 'permission-cancel' })
    await pending
    assert.equal(permissionSignal.aborted, true)
    assert.deepEqual(f.replies, [])
    assert.equal(f.vaultCalls.length, 0)
  })

  it('streams only the target store and terminates idle subscriptions on persona revocation', async () => {
    const f = fixture()
    const pending = f.request({ method: 'subscribe', userPk: peer, subscriptionId: 'sub', params: [{ kinds: [3] }] })
    await setImmediate()
    assert.equal(f.streams[0].pubkey, peer)
    assert.equal(f.streams[0].options.appId, 'chat-app')
    assert.equal(f.streams[0].options.deferCacheAccess, true)
    assert.equal(f.permissions.length, 0)
    assert.equal(f.accesses.length, 0)
    f.streams[0].iterator.push({ type: 'event', event: { kind: 3, pubkey: peer } })
    await setImmediate()
    assert.equal(f.replies.at(-1).payload.event.pubkey, peer)
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
    f.streams[0].iterator.push({ type: 'event', event: { kind: 3, pubkey: peer } })
    await pending
    assert.equal(f.replies.length, 1)
    assert.equal(f.replies[0].error.code, 'PUBKEY_NOT_IN_PERSONA')
    assert.equal(f.accesses.length, 0)
    assert.equal(f.streams[0].iterator.closed, true)
  })

  it('aborts an event-store mutation waiting behind storage when the bridge closes', async () => {
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const captured = {}
    const f = fixture({
      getNostrDb: pubkey => ({
        ownerPubkey: pubkey,
        add: async (_event, options) => {
          captured.signal = options.signal
          entered.resolve()
          await release.promise
          return { ok: true }
        }
      })
    })
    const running = f.request({ method: 'add', params: [{ kind: 1, tags: [], created_at: 1, content: '' }] })
    await entered.promise
    f.bridge.dispose()
    assert.equal(captured.signal.aborted, true)
    release.resolve()
    await running
    assert.deepEqual(f.replies, [])
  })

  it('cancels subscriptions and isolates IDs between documents', async () => {
    const waiting = fixture()
    const pendingStart = waiting.request({ method: 'subscribe', userPk: peer, subscriptionId: 'sub', params: [{ kinds: [3] }] })
    await setImmediate()
    assert.equal(waiting.streams.length, 1)
    waiting.bridge.cancel('sub')
    await pendingStart
    assert.equal(waiting.streams[0].iterator.closed, true)

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

  it('cancels one-shot operations by request id without replying', async () => {
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const f = fixture({
      getNostrDb: pubkey => ({
        ownerPubkey: pubkey,
        query: async () => {
          entered.resolve()
          await release.promise
          return { results: [] }
        }
      })
    })
    const first = f.bridge.handle({ data: { reqId: 'request-a', payload: { method: 'query', params: [{}] } } })
    await entered.promise
    f.bridge.cancel({ requestId: 'request-a' })
    release.resolve()
    await first
    assert.deepEqual(f.replies, [])
    assert.equal(f.bridge.cancel({ requestId: 'unknown' }), undefined)
  })

  it('enforces the launcher-side one-shot deadline and discards a late result', async () => {
    const timers = manualTimers()
    const release = Promise.withResolvers()
    const f = fixture({
      ...timers,
      getNostrDb: pubkey => ({
        ownerPubkey: pubkey,
        add: async () => {
          await release.promise
          return { ok: true }
        }
      })
    })
    const pending = f.bridge.handle({
      data: {
        reqId: 'deadline',
        payload: {
          method: 'add',
          params: [{ kind: 1, tags: [], created_at: 1, content: '' }],
          deadlineAt: 1_500
        }
      }
    })
    await setImmediate()
    assert.equal(timers.scheduled.at(-1).delay, 500)
    timers.fire(timers.scheduled.at(-1))
    release.resolve()
    await pending
    assert.equal(f.replies.at(-1).error.code, 'NOSTRDB_REQUEST_TIMEOUT')
  })

  it('times out an initial snapshot at seven minutes and then after sixty seconds without progress', async () => {
    const timers = manualTimers()
    const f = fixture(timers)
    const pending = f.bridge.handle({
      data: {
        reqId: 'snapshot',
        payload: {
          method: 'subscribe',
          subscriptionId: 'sub',
          params: [{ kinds: [3] }, { initial: true }]
        }
      }
    })
    await setImmediate()
    const first = timers.active().at(-1)
    assert.equal(first.delay, 7 * 60 * 1000)
    f.streams[0].iterator.push({ type: 'event', event: { kind: 3, pubkey: peer } })
    await setImmediate()
    const idle = timers.active().at(-1)
    assert.equal(first.cancelled, true)
    assert.equal(idle.delay, 60 * 1000)
    timers.fire(idle)
    await pending
    assert.equal(f.replies.at(-1).error.code, 'NOSTRDB_SNAPSHOT_TIMEOUT')
    assert.equal(f.replies.at(-1).isLast, true)
    assert.equal(f.streams[0].iterator.closed, true)
  })

  it('disables snapshot timers after eose and never applies them to live-only subscriptions', async () => {
    const timers = manualTimers()
    const f = fixture(timers)
    const pending = f.bridge.handle({
      data: {
        reqId: 'initial',
        payload: {
          method: 'subscribe',
          subscriptionId: 'initial',
          params: [{ kinds: [3] }, { initial: true }]
        }
      }
    })
    await setImmediate()
    f.streams[0].iterator.push({ type: 'eose' })
    await setImmediate()
    assert.deepEqual(timers.active(), [])
    f.bridge.cancel({ subscriptionId: 'initial' })
    await pending

    const live = fixture(timers)
    const livePending = live.bridge.handle({
      data: {
        reqId: 'live',
        payload: {
          method: 'subscribe',
          subscriptionId: 'live',
          params: [{ kinds: [3] }]
        }
      }
    })
    await setImmediate()
    assert.deepEqual(timers.active(), [])
    live.bridge.cancel({ subscriptionId: 'live' })
    await livePending
  })
})

it('remove rejects persona revocation during permission authorization and never signs', async () => {
  const pending = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const f = fixture({ requestPermission: async () => { entered.resolve(); await pending.promise } })
  const request = f.request({ method: 'remove', userPk: peer, params: [[['e', 'ab'.repeat(32)]]] })
  await entered.promise
  f.state.members = [owner]
  pending.resolve()
  await request
  assert.equal(f.replies.at(-1).error.code, 'PUBKEY_NOT_IN_PERSONA')
  assert.equal(f.vaultCalls.length, 0)
  f.bridge.dispose()
})

it('blocks all read-only operations before prompts or DB creation, preserving persona precedence and static supports', async () => {
  const f = fixture()
  try {
    f.flags.set(accountKey(peer), { isReadOnly: true })
    for (const method of ['add', 'addPersonalCopy', 'remove', 'query', 'count', 'subscribe']) {
      await f.request({ method, userPk: peer, params: [{}], subscriptionId: method })
      assert.equal(f.replies.at(-1).error.code, 'READ_ONLY_ACCOUNT')
    }
    await f.request({ method: 'supports', userPk: peer })
    assert.ok(f.replies.at(-1).payload.includes('subscribe:initial'))
    f.state.members = [owner]
    await f.request({ method: 'query', userPk: peer })
    assert.equal(f.replies.at(-1).error.code, 'PUBKEY_NOT_IN_PERSONA')
    assert.deepEqual(f.databases, [])
    assert.deepEqual(f.permissions, [])
    assert.deepEqual(f.vaultCalls, [])
  } finally { f.bridge.dispose() }
})

it('read-only state invalidates an idle app subscription without a new event', async () => {
  const f = fixture()
  try {
    const running = f.request({ method: 'subscribe', userPk: peer, params: [{}], subscriptionId: 'readonly' })
    await setImmediate()
    f.flags.set(accountKey(peer), { isReadOnly: true })
    notifyNostrDbAccessChanged()
    await running
    assert.equal(f.replies.at(-1).error.code, 'READ_ONLY_ACCOUNT')
    assert.equal(f.streams[0].iterator.closed, true)
  } finally { f.bridge.dispose() }
})

it('inherits personal-copy scheduling per request without changing cached database callbacks', async () => {
  const { finalizeEvent } = await import('libp2r2p/event')
  const { askNip07 } = await import('../../src/helpers/window-message/browser/nip07.js')
  const secret = new Uint8Array(32).fill(1)
  const identity = finalizeEvent({ kind: 0, created_at: 1, tags: [], content: '' }, secret).pubkey
  const calls = []; const cached = []
  const baseAsk = async (message, options) => {
    calls.push({ message, options })
    const { method, params } = message.payload
    if (message.code === 'NIP07_BATCH') return { payload: message.payload.operations.map(() => 'a'.repeat(64)) }
    return { payload: method.includes('sign') ? finalizeEvent(params[0], secret) : method === 'obfuscate' ? 'a'.repeat(64) : 'ciphertext' }
  }
  const f = fixture({
    ownerPubkey: identity, readPersonaPublicKeys: () => [identity], askNip07, askVault: baseAsk,
    getNostrDb: (pubkey, options) => { cached.push(options); return { ownerPubkey: pubkey, add: async () => ({ ok: true }) } }
  })
  const send = (kind, options = {}, tags = []) => f.request({
    method: 'addPersonalCopy',
    params: [{ kind, created_at: 1, tags, content: kind === 30078 ? '' : 'private' }, options]
  })
  await send(9)
  assert.ok(calls.length >= 3)
  assert.ok(calls.every(call => call.options.scheduling.priority === true))
  assert.ok(calls.every(call => call.options.signal instanceof AbortSignal))
  assert.ok(calls.some(call => call.message.payload.method === 'obfuscateMany'))
  assert.ok(calls.some(call => call.message.payload.method === 'double_sign_event'))
  calls.length = 0
  await send(3)
  assert.ok(calls.every(call => call.options.scheduling.priority === false))
  calls.length = 0
  await send(9, { recovery: true })
  assert.ok(calls.every(call => call.options.scheduling.archive === false))
  calls.length = 0
  await send(30078, { recovery: true }, [['d', `libp2r2p:recovery:seed:${'a'.repeat(64)}`]])
  assert.ok(calls.length > 0)
  assert.ok(calls.every(call => call.options.scheduling.archive === true))
  calls.length = 0
  await cached[0].personalCopyObfuscate('value', 1006, '.id')
  assert.equal(calls[0].options.scheduling, undefined)
})
