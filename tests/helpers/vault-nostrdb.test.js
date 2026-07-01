import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

globalThis.IS_DEVELOPMENT = true

const {
  cancelTrustedVaultNostrDbSubscription,
  createTrustedVaultNostrDbSignEvent,
  pruneNostrDbsForVaultAccounts,
  runTrustedVaultNostrDbMethod,
  streamTrustedVaultNostrDbSubscription
} = await import('../../src/helpers/window-message/browser/vault-nostrdb.js')

describe('trusted vault nostrdb bridge helpers', () => {
  it('runs app-neutral one-shot methods for vault-selected owners', async () => {
    const ownerPubkey = 'b'.repeat(64)
    const event = { kind: 1, tags: [] }
    let seen
    let dbOptions
    let activeVaultPort = 'old-vault-port'
    const signCalls = []
    const db = {
      async add (addedEvent, options) {
        seen = { addedEvent, options }
        return { ok: true }
      }
    }

    assert.deepEqual(await runTrustedVaultNostrDbMethod({
      vaultPort: 'vault-port',
      ownerPubkey,
      getVaultPort: () => activeVaultPort,
      getNostrDb: (pubkey, options) => {
        assert.equal(pubkey, ownerPubkey)
        dbOptions = options
        return db
      },
      method: 'add',
      params: [event, {
        appId: 'app-supplied',
        mergeSource: 'sync',
        signEvent: async () => ({ id: 'app-signed' }),
        mergeReplaceable: false
      }],
      ask: async (port, message, options) => {
        signCalls.push({ port, message, options })
        return { payload: { id: `${message.payload.method}:signed` } }
      }
    }), { ok: true })

    assert.equal(seen.addedEvent, event)
    assert.equal(seen.options.appId, undefined)
    assert.equal(seen.options.mergeSource, 'sync')
    assert.equal(typeof seen.options.signEvent, 'function')
    assert.equal(seen.options.mergeReplaceable, false)
    assert.equal(typeof dbOptions.maintenanceOptions.signEvent, 'function')
    activeVaultPort = 'new-vault-port'
    assert.deepEqual(await dbOptions.maintenanceOptions.signEvent({ kind: 5, tags: [['e', 'target']] }), { id: 'sign_event:signed' })
    assert.equal(signCalls.length, 1)
    assert.equal(signCalls[0].port, 'new-vault-port')
    assert.equal(signCalls[0].message.payload.method, 'sign_event')
    assert.equal(signCalls[0].message.payload.context, 'nostrdb_maintenance')
  })

  it('prunes nostrdb databases for accounts no longer advertised by the vault', async () => {
    const deleted = []
    assert.deepEqual(await pruneNostrDbsForVaultAccounts([
      { pubkey: 'a'.repeat(64) },
      { pubkey: 'B'.repeat(64) }
    ], {
      indexedDB: {
        async databases () {
          return [
            { name: `44billion_nostrdb:${'a'.repeat(64)}` },
            { name: `44billion_nostrdb:${'b'.repeat(64)}` },
            { name: `44billion_nostrdb:${'c'.repeat(64)}` },
            { name: 'other-db' }
          ]
        }
      },
      deleteNostrDb: async pubkey => {
        deleted.push(pubkey)
        return true
      }
    }), ['c'.repeat(64)])
    assert.deepEqual(deleted, ['c'.repeat(64)])
  })

  it('uses permissionless vault signing with nostrdb merge context', async () => {
    const calls = []
    const signEvent = createTrustedVaultNostrDbSignEvent({
      vaultPort: 'vault-port',
      ownerPubkey: 'e'.repeat(64),
      ask: async (port, message, options) => {
        calls.push({ port, message, options })
        return { payload: { id: `${message.payload.method}:signed` } }
      }
    })

    assert.deepEqual(await signEvent({ kind: 1, tags: [] }), { id: 'sign_event:signed' })
    assert.deepEqual(await signEvent({ kind: 1, tags: [['imkc', 'old']] }), { id: 'double_sign_event:signed' })
    assert.deepEqual(calls.map(call => call.message.payload.method), ['sign_event', 'double_sign_event'])
    assert.deepEqual(calls.map(call => call.message.payload.context), ['nostrdb_merge', 'nostrdb_merge'])
    assert.deepEqual(calls.map(call => call.message.payload.app.id), ['ez-vault', 'ez-vault'])
    assert.deepEqual(calls.map(call => call.options), [{ timeout: 120000 }, { timeout: 120000 }])
  })

  it('exports one trusted-vault app page with an after cursor', async () => {
    const ownerPubkey = 'a'.repeat(64)
    const events = [
      { id: '1'.repeat(64), kind: 30078 },
      { id: '2'.repeat(64), kind: 30078 },
      { id: '3'.repeat(64), kind: 30078 }
    ]
    let seenAppId
    let seenOptions

    const result = await runTrustedVaultNostrDbMethod({
      vaultPort: 'vault-port',
      ownerPubkey,
      getNostrDb: () => ({
        async * exportEventsByApp (appId, options) {
          seenAppId = appId
          seenOptions = options
          yield events
        }
      }),
      method: 'exportEventsByAppPage',
      params: ['app-1', { batchSize: 2, after: 'f'.repeat(64) }]
    })

    assert.equal(seenAppId, 'app-1')
    assert.deepEqual(seenOptions, { batchSize: 3, after: 'f'.repeat(64) })
    assert.deepEqual(result.events, events.slice(0, 2))
    assert.equal(result.nextAfter, '2'.repeat(64))
    assert.equal(result.hasMore, true)
  })

  it('imports trusted-vault app events with app ownership and sync merge source', async () => {
    const ownerPubkey = 'a'.repeat(64)
    const events = [{ id: '1'.repeat(64), kind: 30078 }, { id: '2'.repeat(64), kind: 30078 }]
    const added = []

    assert.deepEqual(await runTrustedVaultNostrDbMethod({
      vaultPort: 'vault-port',
      ownerPubkey,
      getNostrDb: () => ({
        async add (event, options) {
          added.push({ event, options })
          return event.id === events[1].id ? { ok: false } : { ok: true }
        }
      }),
      method: 'addEventsForApp',
      params: ['app-1', events]
    }), { added: 1, skipped: 1 })

    assert.deepEqual(added.map(call => call.event), events)
    assert.deepEqual(added.map(call => call.options.appId), ['app-1', 'app-1'])
    assert.deepEqual(added.map(call => call.options.mergeSource), ['sync', 'sync'])
    assert.equal(typeof added[0].options.signEvent, 'function')
  })

  it('streams subscription items and sends a done sentinel', async () => {
    const ownerPubkey = 'f'.repeat(64)
    const replies = []
    const subscriptions = new Map()
    let dbOptions
    const db = {
      async * subscribe (...params) {
        assert.deepEqual(params, [{ kinds: [1] }])
        yield { result: { id: 'event' }, meta: { source: 'local' } }
      }
    }

    await streamTrustedVaultNostrDbSubscription({
      data: { reqId: 'req' },
      origin: ''
    }, {
      vaultPort: 'vault-port',
      ownerPubkey,
      params: [{ kinds: [1] }],
      subscriptionId: 'sub-1',
      subscriptions,
      getNostrDb: (pubkey, options) => {
        assert.equal(pubkey, ownerPubkey)
        dbOptions = options
        return db
      },
      reply: (_e, message, options) => replies.push({ message, options })
    })

    assert.deepEqual(replies, [
      {
        message: { payload: { result: { id: 'event' }, meta: { source: 'local' } }, isLast: false },
        options: { to: 'vault-port' }
      },
      {
        message: { payload: { type: 'nostrdb:done', subscriptionId: 'sub-1' }, isLast: true },
        options: { to: 'vault-port' }
      }
    ])
    assert.equal(subscriptions.size, 0)
    assert.equal(typeof dbOptions.maintenanceOptions.signEvent, 'function')
  })

  it('cancels active subscriptions', async () => {
    let returned = false
    const subscriptions = new Map([[
      'sub-1',
      {
        iterator: { async return () { returned = true } },
        cancelled: false
      }
    ]])

    cancelTrustedVaultNostrDbSubscription(subscriptions, 'sub-1')

    assert.equal(returned, true)
    assert.equal(subscriptions.get('sub-1').cancelled, true)
  })
})
