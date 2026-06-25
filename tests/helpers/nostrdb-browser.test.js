import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  BROAD_EVENT_KIND,
  EVENT_READ_PERMISSION,
  EVENT_WRITE_PERMISSION,
  ONE_TIME_DELETE_PERMISSION
} from '../../src/helpers/window-message/browser/event-permissions.js'
import {
  buildNostrDbAddOptions,
  buildNostrDbReadOptions,
  createNostrDbMaintenanceSignEvent,
  createNostrDbSignEvent,
  createNostrDbSubscriptionAuthorizer,
  explicitFilterKinds,
  NOSTRDB_MAINTENANCE_CONTEXT,
  nostrDbSignMethodForTemplate,
  runNostrDbMethod
} from '../../src/helpers/window-message/browser/nostrdb.js'

describe('nostrdb browser bridge helpers', () => {
  it('forces add appId, mergeSource, and signEvent after write permission', async () => {
    const event = { id: 'event', kind: 1, tags: [] }
    const forcedSignEvent = async () => ({ id: 'signed' })
    const calls = []
    let seen
    const db = {
      async add (addedEvent, options) {
        calls.push('add')
        seen = { addedEvent, options }
        return { ok: true }
      }
    }
    const requestPermission = async req => {
      calls.push(['permission', req.name, req.eKind])
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
      signEvent: forcedSignEvent,
      requestPermission,
      app: { id: 'app' }
    }), { ok: true })

    assert.deepEqual(calls, [['permission', EVENT_WRITE_PERMISSION, 1], 'add'])
    assert.equal(seen.addedEvent, event)
    assert.equal(seen.options.appId, 'real-app')
    assert.equal(seen.options.mergeSource, 'local')
    assert.equal(seen.options.signEvent, forcedSignEvent)
    assert.equal(seen.options.mergeReplaceable, false)
  })

  it('uses deletion target permissions for nostrdb add', async () => {
    const seen = []
    const db = { async add () { return { ok: true } } }
    const requestPermission = async req => { seen.push([req.name, req.eKind, req.remember]) }

    await runNostrDbMethod({
      db,
      method: 'add',
      params: [{ kind: 5, tags: [['a', `30023:${'a'.repeat(64)}:article`]] }],
      requestPermission,
      app: { id: 'app' }
    })
    await runNostrDbMethod({
      db,
      method: 'add',
      params: [{ kind: 5, tags: [['e', 'b'.repeat(64)]] }],
      requestPermission,
      app: { id: 'app' }
    })

    assert.deepEqual(seen, [
      [EVENT_WRITE_PERMISSION, 30023, undefined],
      [ONE_TIME_DELETE_PERMISSION, 5, false]
    ])
  })

  it('delegates query, count, and supports with read permissions', async () => {
    const calls = []
    const requestPermission = async req => { calls.push(['permission', req.name, req.eKind]) }
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

    assert.deepEqual(await runNostrDbMethod({
      db,
      method: 'query',
      params: [{ kinds: [1] }],
      requestPermission,
      appId: 'real-app',
      app: { id: 'app' }
    }), { results: ['event'] })
    assert.equal(await runNostrDbMethod({
      db,
      method: 'count',
      params: [{ authors: ['a'.repeat(64)] }],
      requestPermission,
      app: { id: 'app' }
    }), 7)
    assert.deepEqual(await runNostrDbMethod({ db, method: 'supports', params: [] }), ['search'])
    assert.deepEqual(calls, [
      ['permission', EVENT_READ_PERMISSION, 1],
      ['query', [{ kinds: [1] }, { appId: 'real-app' }]],
      ['permission', EVENT_READ_PERMISSION, BROAD_EVENT_KIND],
      ['count', [{ authors: ['a'.repeat(64)] }]],
      ['supports', []]
    ])
  })

  it('gates query results by returned kinds when filters do not declare kinds', async () => {
    const seen = []
    const db = {
      async query () {
        seen.push('query')
        return { results: [{ kind: 1 }, { kind: 30023 }, 'id-only'] }
      }
    }
    const requestPermission = async req => { seen.push([req.name, req.eKind]) }

    await runNostrDbMethod({
      db,
      method: 'query',
      params: [{ authors: ['a'.repeat(64)] }],
      requestPermission,
      app: { id: 'app' }
    })

    assert.deepEqual(seen, [
      'query',
      [EVENT_READ_PERMISSION, 1],
      [EVENT_READ_PERMISSION, 30023],
      [EVENT_READ_PERMISSION, BROAD_EVENT_KIND]
    ])
  })

  it('rejects unknown nostrdb methods', async () => {
    await assert.rejects(
      () => runNostrDbMethod({ db: {}, method: 'deleteDb' }),
      /Unknown nostrdb method deleteDb/
    )
  })

  it('extracts explicit filter kinds only when every filter declares kinds', () => {
    assert.deepEqual(explicitFilterKinds({ kinds: [2, 1, 2] }), [1, 2])
    assert.deepEqual(explicitFilterKinds([{ kinds: [1] }, { kinds: [30023] }]), [1, 30023])
    assert.equal(explicitFilterKinds([{ kinds: [1] }, { authors: ['a'.repeat(64)] }]), null)
    assert.equal(explicitFilterKinds({ authors: ['a'.repeat(64)] }), null)
  })

  it('authorizes subscriptions before start or per streamed item', async () => {
    const explicitCalls = []
    const explicit = createNostrDbSubscriptionAuthorizer({
      app: { id: 'app' },
      requestPermission: async req => { explicitCalls.push([req.name, req.eKind]) },
      params: [{ kinds: [1, 30023] }]
    })
    await explicit.authorizeBeforeStart()
    await explicit.authorizeItem({ result: { kind: 1 } })
    assert.deepEqual(explicitCalls, [
      [EVENT_READ_PERMISSION, 1],
      [EVENT_READ_PERMISSION, 30023]
    ])

    const dynamicCalls = []
    const dynamic = createNostrDbSubscriptionAuthorizer({
      app: { id: 'app' },
      requestPermission: async req => { dynamicCalls.push([req.name, req.eKind]) },
      params: [{ authors: ['a'.repeat(64)] }]
    })
    await dynamic.authorizeBeforeStart()
    await dynamic.authorizeItem({ result: { kind: 1 } })
    await dynamic.authorizeItem({ result: { kind: 1 } })
    await dynamic.authorizeItem({ result: 'id-only' })
    assert.deepEqual(dynamicCalls, [
      [EVENT_READ_PERMISSION, 1],
      [EVENT_READ_PERMISSION, BROAD_EVENT_KIND]
    ])
  })

  it('propagates permission denial before nostrdb add', async () => {
    let added = false
    await assert.rejects(
      () => runNostrDbMethod({
        db: { async add () { added = true } },
        method: 'add',
        params: [{ kind: 1, tags: [] }],
        requestPermission: async () => { throw new Error('Permission denied') },
        app: { id: 'app' }
      }),
      /Permission denied/
    )
    assert.equal(added, false)
  })

  it('selects regular or double signing from the template imkc tag', async () => {
    assert.equal(nostrDbSignMethodForTemplate({ tags: [] }), 'sign_event')
    assert.equal(nostrDbSignMethodForTemplate({ kind: 5, tags: [['e', 'target']] }), 'sign_event')
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

  it('creates a permissionless vault maintenance signer wrapper', async () => {
    const calls = []
    const signEvent = createNostrDbMaintenanceSignEvent({
      askVault: async (message, options) => {
        calls.push({ message, options })
        return { payload: { id: `${message.payload.method}:signed` } }
      },
      pubkey: 'owner'
    })

    assert.deepEqual(await signEvent({ kind: 5, tags: [['e', 'target']] }), { id: 'sign_event:signed' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].message.code, 'NIP07')
    assert.equal(calls[0].message.payload.method, 'sign_event')
    assert.equal(calls[0].message.payload.context, NOSTRDB_MAINTENANCE_CONTEXT)
    assert.equal(Object.hasOwn(calls[0].message.payload, 'app'), false)
    assert.deepEqual(calls[0].options, { timeout: 120000 })
  })

  it('buildNostrDbAddOptions ignores non-object app options', () => {
    const signEvent = async () => {}
    assert.deepEqual(buildNostrDbAddOptions(null, { appId: 'app', signEvent }), {
      appId: 'app',
      mergeSource: 'local',
      signEvent
    })
  })

  it('buildNostrDbReadOptions forces the launcher app id', () => {
    assert.deepEqual(buildNostrDbReadOptions({
      appId: 'evil-app',
      limit: 10
    }, { appId: 'real-app' }), {
      appId: 'real-app',
      limit: 10
    })
  })
})
