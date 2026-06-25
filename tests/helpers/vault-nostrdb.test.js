import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

globalThis.IS_DEVELOPMENT = true

const {
  accountPubkeysFromVaultAccounts,
  cancelTrustedVaultNostrDbSubscription,
  createTrustedVaultNostrDbSignEvent,
  runTrustedVaultNostrDbMethod,
  streamTrustedVaultNostrDbSubscription
} = await import('../../src/helpers/window-message/browser/vault-nostrdb.js')

describe('trusted vault nostrdb bridge helpers', () => {
  it('extracts vault account pubkeys for owner validation', () => {
    assert.deepEqual(
      [...accountPubkeysFromVaultAccounts([
        { pubkey: 'A'.repeat(64) },
        { pubkey: 'not-a-pubkey' },
        null
      ])],
      ['a'.repeat(64)]
    )
  })

  it('runs app-neutral one-shot methods for vault-selected owners', async () => {
    const ownerPubkey = 'b'.repeat(64)
    const event = { kind: 1, tags: [] }
    let seen
    const db = {
      async add (addedEvent, options) {
        seen = { addedEvent, options }
        return { ok: true }
      }
    }

    assert.deepEqual(await runTrustedVaultNostrDbMethod({
      vaultPort: 'vault-port',
      ownerPubkey,
      allowedPubkeys: new Set([ownerPubkey]),
      getNostrDb: pubkey => {
        assert.equal(pubkey, ownerPubkey)
        return db
      },
      method: 'add',
      params: [event, {
        appId: 'app-supplied',
        mergeSource: 'sync',
        signEvent: async () => ({ id: 'app-signed' }),
        mergeReplaceable: false
      }],
      ask: async () => ({ payload: { id: 'signed' } })
    }), { ok: true })

    assert.equal(seen.addedEvent, event)
    assert.equal(seen.options.appId, undefined)
    assert.equal(seen.options.mergeSource, 'local')
    assert.equal(typeof seen.options.signEvent, 'function')
    assert.equal(seen.options.mergeReplaceable, false)
  })

  it('rejects owners not advertised by the vault', async () => {
    await assert.rejects(
      () => runTrustedVaultNostrDbMethod({
        vaultPort: 'vault-port',
        ownerPubkey: 'c'.repeat(64),
        allowedPubkeys: new Set(['d'.repeat(64)]),
        getNostrDb: () => ({ async supports () {} }),
        method: 'supports'
      }),
      /NOSTRDB_OWNER_NOT_AVAILABLE/
    )
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

  it('streams subscription items and sends a done sentinel', async () => {
    const ownerPubkey = 'f'.repeat(64)
    const replies = []
    const subscriptions = new Map()
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
      allowedPubkeys: new Set([ownerPubkey]),
      subscriptions,
      getNostrDb: pubkey => {
        assert.equal(pubkey, ownerPubkey)
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
