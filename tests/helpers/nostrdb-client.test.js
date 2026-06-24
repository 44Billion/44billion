import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

globalThis.IS_DEVELOPMENT = true

const { createNostrDb } = await import('../../src/helpers/window-message/nostrdb-client.js')

describe('nostrdb app-page client bridge', () => {
  it('exposes only public nostrdb methods', () => {
    const nostrdb = createNostrDb(Promise.resolve('port'), {
      ask: async () => ({ payload: null }),
      askStream: async function * () {},
      tell: () => {}
    })

    assert.deepEqual(Object.keys(nostrdb).sort(), ['add', 'count', 'query', 'subscribe', 'supports'])
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
