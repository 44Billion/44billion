import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

globalThis.IS_DEVELOPMENT = true

const { createNostrDb, injectEventStore } = await import('../../src/helpers/window-message/nostrdb-client.js')

describe('nostrdb app-page client bridge', () => {
  it('does not start a subscription cancelled before the handshake', async () => {
    const port = Promise.withResolvers()
    let started = false
    const db = createNostrDb(port.promise, {
      askStream: async function * () { started = true }
    })
    const iterator = db.subscribe({ kinds: [3] })
    const next = iterator.next()
    assert.deepEqual(await iterator.return(), { done: true })
    port.resolve('port')
    assert.deepEqual(await next, { done: true })
    assert.equal(started, false)
  })

  it('closes the transport iterator when a scoped subscription rejects', async () => {
    let closed = false
    const denied = Object.assign(new Error('Removed'), { code: 'PUBKEY_NOT_IN_PERSONA' })
    const db = createNostrDb(Promise.resolve('port'), {
      askStream: async function * () {
        try { yield { error: denied } } finally { closed = true }
      }
    })
    const iterator = db.subscribe({ kinds: [3] })
    await assert.rejects(iterator.next(), { code: 'PUBKEY_NOT_IN_PERSONA' })
    assert.equal(closed, true)
    assert.deepEqual(await iterator.next(), { done: true })
  })

  it('creates persona event stores synchronously and forwards their target after the handshake', async () => {
    const port = Promise.withResolvers()
    const calls = []
    const target = { napp: {} }
    injectEventStore(target, port.promise, {
      ask: async (_port, message) => { calls.push(message); return { payload: 'ok' } },
      askStream: async function * (_port, message) {
        calls.push(message)
        yield { payload: 'item' }
      },
      tell: (_port, message) => calls.push(message)
    })
    const pubkey = 'ab'.repeat(32)
    const store = target.napp.getWindowNappEventStoreFor(pubkey)
    assert.deepEqual(Object.keys(store).sort(), Object.keys(target.napp.eventStore).sort())
    const pending = store.query({ kinds: [3] })
    await Promise.resolve()
    assert.equal(calls.length, 0)
    port.resolve('port')
    assert.equal(await pending, 'ok')
    for (const method of ['add', 'addPersonalCopy', 'count', 'supports']) await store[method]()
    const iterator = store.subscribe({ kinds: [3] })
    assert.deepEqual(await iterator.next(), { value: 'item', done: false })
    assert.ok(calls.every(message => message.payload.userPk === pubkey))
    await iterator.return()
    assert.equal(calls.at(-1).code, 'NOSTRDB_CANCEL')
    await target.napp.eventStore.supports()
    assert.equal(Object.hasOwn(calls.at(-1).payload, 'userPk'), false)
  })

  it('exposes only public nostrdb methods', () => {
    const nostrdb = createNostrDb(Promise.resolve('port'), {
      ask: async () => ({ payload: null }),
      askStream: async function * () {},
      tell: () => {}
    })

    assert.deepEqual(Object.keys(nostrdb).sort(), ['add', 'addPersonalCopy', 'count', 'query', 'subscribe', 'supports'])
  })

  it('injects eventStore before the handshake', async () => {
    const port = Promise.withResolvers()
    const calls = []
    const target = { napp: {} }
    const eventStore = injectEventStore(target, port.promise, {
      ask: async (...args) => {
        calls.push(args)
        return { payload: 'ok' }
      },
      askStream: async function * () {},
      tell: () => {}
    })

    assert.equal(target.napp.eventStore, eventStore)

    const result = eventStore.query({ kinds: [1] })
    await Promise.resolve()
    assert.equal(calls.length, 0)

    port.resolve('port')
    assert.equal(await result, 'ok')
    assert.equal(calls[0][0], 'port')
    assert.equal(calls[0][1].code, 'NOSTRDB')
  })

  it('sends one-shot methods over NOSTRDB', async () => {
    const calls = []
    const nostrdb = createNostrDb(Promise.resolve('port'), {
      ask: async (port, message, options) => {
        calls.push({ port, message, options })
        return { payload: 'ok' }
      },
      askStream: async function * () {},
      tell: () => {},
      timeout: 123
    })

    assert.equal(await nostrdb.add({ id: 'event' }, { appId: 'ignored' }), 'ok')
    assert.equal(await nostrdb.addPersonalCopy({ kind: 1 }, { context: 'dm:alice' }), 'ok')
    assert.deepEqual(calls, [{
      port: 'port',
      message: {
        code: 'NOSTRDB',
        payload: {
          method: 'add',
          params: [{ id: 'event' }, { appId: 'ignored' }]
        }
      },
      options: { timeout: 123 }
    }, {
      port: 'port',
      message: {
        code: 'NOSTRDB',
        payload: {
          method: 'addPersonalCopy',
          params: [{ kind: 1 }, { context: 'dm:alice' }]
        }
      },
      options: { timeout: 123 }
    }])
  })

  it('streams subscribe results and sends cancel on return', async () => {
    const calls = []
    const nostrdb = createNostrDb(Promise.resolve('port'), {
      ask: async () => ({ payload: null }),
      askStream: async function * (port, message, options) {
        calls.push({ type: 'askStream', port, message, options })
        yield { payload: { result: { id: 'event' }, meta: { score: 1 } } }
      },
      tell: (port, message) => calls.push({ type: 'tell', port, message }),
      makeSubscriptionId: () => 'sub-1'
    })

    const iterator = nostrdb.subscribe({ kinds: [1] })
    assert.deepEqual(await iterator.next(), {
      value: { result: { id: 'event' }, meta: { score: 1 } },
      done: false
    })
    assert.deepEqual(await iterator.return(), { done: true })

    assert.deepEqual(calls, [
      {
        type: 'askStream',
        port: 'port',
        message: {
          code: 'NOSTRDB',
          payload: {
            method: 'subscribe',
            params: [{ kinds: [1] }],
            subscriptionId: 'sub-1'
          }
        },
        options: { timeout: null }
      },
      {
        type: 'tell',
        port: 'port',
        message: {
          code: 'NOSTRDB_CANCEL',
          payload: { subscriptionId: 'sub-1' }
        }
      }
    ])
  })
})
