import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildNostrDbAddOptions,
  createNostrDbSignEvent,
  nostrDbSignMethodForTemplate,
  runNostrDbMethod
} from '../../src/helpers/window-message/browser/nostrdb.js'

describe('nostrdb browser bridge helpers', () => {
  it('forces add appId, mergeSource, and signEvent', async () => {
    const event = { id: 'event' }
    const forcedSignEvent = async () => ({ id: 'signed' })
    let seen
    const db = {
      async add (addedEvent, options) {
        seen = { addedEvent, options }
        return { ok: true }
      }
    }

    assert.deepEqual(await runNostrDbMethod({
      db,
      method: 'add',
      params: [event, {
        appId: 'evil-app',
        mergeSource: 'sync',
        signEvent: async () => ({ id: 'evil' }),
        mergeReplaceable: false
      }],
      appId: 'real-app',
      signEvent: forcedSignEvent
    }), { ok: true })

    assert.equal(seen.addedEvent, event)
    assert.equal(seen.options.appId, 'real-app')
    assert.equal(seen.options.mergeSource, 'local')
    assert.equal(seen.options.signEvent, forcedSignEvent)
    assert.equal(seen.options.mergeReplaceable, false)
  })

  it('delegates query, count, and supports to the scoped db', async () => {
    const calls = []
    const db = {
      async query (...args) {
        calls.push(['query', args])
        return { results: ['event'] }
      },
      async count (...args) {
        calls.push(['count', args])
        return 7
      },
      async supports (...args) {
        calls.push(['supports', args])
        return ['search']
      }
    }

    assert.deepEqual(await runNostrDbMethod({ db, method: 'query', params: [{ kinds: [1] }] }), { results: ['event'] })
    assert.equal(await runNostrDbMethod({ db, method: 'count', params: [{ kinds: [1] }] }), 7)
    assert.deepEqual(await runNostrDbMethod({ db, method: 'supports', params: [] }), ['search'])
    assert.deepEqual(calls, [
      ['query', [{ kinds: [1] }]],
      ['count', [{ kinds: [1] }]],
      ['supports', []]
    ])
  })

  it('rejects unknown nostrdb methods', async () => {
    await assert.rejects(
      () => runNostrDbMethod({ db: {}, method: 'deleteDb' }),
      /Unknown nostrdb method deleteDb/
    )
  })

  it('selects regular or double signing from the template imkc tag', async () => {
    assert.equal(nostrDbSignMethodForTemplate({ tags: [] }), 'sign_event')
    assert.equal(nostrDbSignMethodForTemplate({ tags: [['imkc', 'pubkey', 'proof']] }), 'double_sign_event')
  })

  it('creates a permissionless vault signer wrapper', async () => {
    const calls = []
    const askNip07 = async (askVault, pubkey, request, options) => {
      calls.push({ askVault, pubkey, request, options })
      return { payload: { id: `${request.method}:signed` } }
    }
    const signEvent = createNostrDbSignEvent({
      askNip07,
      askVault: 'vault',
      pubkey: 'owner',
      app: async () => ({ id: 'app', napp: '+app' }),
      isDefaultUser: false
    })

    assert.deepEqual(await signEvent({ kind: 1, tags: [] }), { id: 'sign_event:signed' })
    assert.deepEqual(await signEvent({ kind: 1, tags: [['imkc', 'old']] }), { id: 'double_sign_event:signed' })
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map(call => call.request.method), ['sign_event', 'double_sign_event'])
    assert.deepEqual(calls.map(call => call.request.context), ['nostrdb_merge', 'nostrdb_merge'])
    assert.equal(calls.every(call => !('requestPermission' in call.options)), true)
    assert.deepEqual(calls.map(call => call.options.app.napp), ['+app', '+app'])
  })

  it('buildNostrDbAddOptions ignores non-object app options', () => {
    const signEvent = async () => {}
    assert.deepEqual(buildNostrDbAddOptions(null, { appId: 'app', signEvent }), {
      appId: 'app',
      mergeSource: 'local',
      signEvent
    })
  })
})
