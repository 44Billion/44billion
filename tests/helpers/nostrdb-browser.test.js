import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent } from 'nostr-tools'

import {
  BROAD_EVENT_KIND,
  EVENT_ACCESS_PERMISSION,
  EVENT_ACCESS_PERSONAL_PERMISSION,
  ONE_TIME_DELETE_PERMISSION
} from '../../src/helpers/window-message/browser/event-permissions.js'
import {
  buildNostrDbAddOptions,
  buildNostrDbReadOptions,
  createNostrDbMaintenanceSignEvent,
  createNostrDbPersonalCopyDecrypt,
  createNostrDbPersonalCopyEncrypt,
  createNostrDbPersonalCopyObfuscate,
  createNostrDbSignEvent,
  createNostrDbSubscriptionAuthorizer,
  explicitFilterKinds,
  NOSTRDB_PERSONAL_COPY_CONTEXT,
  NOSTRDB_MAINTENANCE_CONTEXT,
  nostrDbSignMethodForTemplate,
  runNostrDbMethod
} from '../../src/helpers/window-message/browser/nostrdb.js'
import {
  PERSONAL_COPY_PROVENANCE,
  personalCopySourceId
} from '../../src/helpers/personal-copy.js'

describe('nostrdb browser bridge helpers', () => {
  it('forces add appId, mergeSource, and signEvent after access permission', async () => {
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

    assert.deepEqual(calls, [['permission', EVENT_ACCESS_PERMISSION, 1], 'add'])
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
      [EVENT_ACCESS_PERMISSION, 30023, undefined],
      [ONE_TIME_DELETE_PERMISSION, 5, false]
    ])
  })

  it('builds, double-signs, and stores personal copies', async () => {
    const owner = 'f'.repeat(64)
    const original = finalizeEvent({
      kind: 1,
      created_at: 123,
      tags: [['t', 'topicexample'], ['p', 'c'.repeat(64)]],
      content: 'secret post'
    }, new Uint8Array(32).fill(3))
    const calls = []
    let added
    let encryptedInner
    const db = {
      ownerPubkey: owner,
      async add (event, options) {
        calls.push('add')
        added = { event, options }
        return { ok: true, code: 'stored' }
      }
    }
    const signed = {
      id: 'e'.repeat(64),
      pubkey: owner,
      sig: '1'.repeat(128)
    }

    const result = await runNostrDbMethod({
      db,
      method: 'addPersonalCopy',
      params: [original, { context: 'dm:alice', appId: 'evil' }],
      appId: 'real-app',
      signEvent: async template => {
        calls.push(['sign', template.kind, template.tags.at(-1)])
        return { ...template, ...signed }
      },
      personalCopyEncrypt: async (kind, plaintext) => {
        encryptedInner = JSON.parse(plaintext)
        calls.push(['encrypt', kind, encryptedInner.content])
        return `cipher-${kind}`
      },
      personalCopyObfuscate: async (value, kind, scope) => `obf:${kind}:${scope}:${value}`,
      requestPermission: async req => { calls.push(['permission', req.name, req.eKind]) },
      app: { id: 'app' }
    })

    assert.deepEqual(calls, [
      ['permission', EVENT_ACCESS_PERSONAL_PERMISSION, 1],
      ['encrypt', 1, 'secret post'],
      ['sign', 1006, ['imkc']],
      'add'
    ])
    assert.equal(result.event.id, signed.id)
    assert.deepEqual(result.result, { ok: true, code: 'stored' })
    assert.equal(encryptedInner.id, original.id)
    assert.equal(encryptedInner.pubkey, original.pubkey)
    assert.equal(encryptedInner.sig, original.sig)
    assert.equal(added.event.content, 'cipher-1')
    assert.equal(added.event.created_at, 123)
    assert.deepEqual(added.event.tags.slice(0, 4), [
      ['k', '1'],
      ['c', 'obf:1006::dm:alice'],
      ['v', PERSONAL_COPY_PROVENANCE.SIGNED_EVENT],
      ['o', 'obf:1006:#t:topicexample']
    ])
    assert.equal(added.event.tags.some(tag => tag[1] === `obf:1006:.id:${original.id}`), true)
    assert.equal(added.options.appId, 'real-app')
    assert.equal(added.options.mergeSource, 'local')
  })

  it('marks unsigned third-party personal copies with hearsay provenance', async () => {
    const owner = 'f'.repeat(64)
    const original = {
      pubkey: 'b'.repeat(64),
      kind: 1,
      created_at: 123,
      tags: [['t', 'topicexample']],
      content: 'secret post'
    }
    let encryptedInner
    let added
    const db = {
      ownerPubkey: owner,
      async add (event, options) {
        added = { event, options }
        return { ok: true, code: 'stored' }
      }
    }

    await runNostrDbMethod({
      db,
      method: 'addPersonalCopy',
      params: [original, { context: 'dm:alice', hearsay: true }],
      appId: 'real-app',
      signEvent: async template => ({ ...template, id: 'e'.repeat(64), pubkey: owner, sig: '1'.repeat(128) }),
      personalCopyEncrypt: async (kind, plaintext) => {
        encryptedInner = JSON.parse(plaintext)
        return `cipher-${kind}`
      },
      personalCopyObfuscate: async (value, kind, scope) => `obf:${kind}:${scope}:${value}`,
      requestPermission: async () => {},
      app: { id: 'app' }
    })

    assert.deepEqual(encryptedInner, JSON.parse(JSON.stringify(original)))
    assert.equal('id' in encryptedInner, false)
    assert.deepEqual(added.event.tags.filter(tag => tag[0] === 'v'), [
      ['v', PERSONAL_COPY_PROVENANCE.HEARSAY_RUMOR]
    ])
    assert.equal(added.event.tags.some(tag => tag[0] === 'hearsay'), false)
    assert.equal(added.event.tags.some(tag => tag[1] === `obf:1006:.id:${personalCopySourceId(original)}`), true)
    assert.equal('hearsay' in added.options, false)
  })

  it('rejects hearsay for self-owned, signed, or identityless inner events', async () => {
    const owner = 'f'.repeat(64)
    const db = { ownerPubkey: owner, async add () { throw new Error('UNEXPECTED_ADD') } }
    const options = {
      db,
      method: 'addPersonalCopy',
      appId: 'real-app',
      signEvent: async () => { throw new Error('UNEXPECTED_SIGN') },
      personalCopyEncrypt: async () => { throw new Error('UNEXPECTED_ENCRYPT') },
      personalCopyObfuscate: async () => 'obfuscated',
      requestPermission: async () => {},
      app: { id: 'app' }
    }

    await assert.rejects(
      runNostrDbMethod({
        ...options,
        params: [{ pubkey: owner, kind: 1, created_at: 1, tags: [], content: 'mine' }, { hearsay: true }]
      }),
      /HEARSAY_SELF_OWNED_EVENT/
    )

    const signed = finalizeEvent({ kind: 1, created_at: 1, tags: [['hearsay']], content: 'signed' }, new Uint8Array(32).fill(1))
    await assert.rejects(
      runNostrDbMethod({ ...options, params: [signed, { hearsay: true }] }),
      /HEARSAY_SIGNED_EVENT/
    )
    await assert.rejects(
      runNostrDbMethod({
        ...options,
        params: [{ pubkey: 'not-a-pubkey', kind: 1, created_at: 1, tags: [], content: 'unknown' }, { hearsay: true }]
      }),
      /INVALID_PERSONAL_COPY_INNER_EVENT/
    )
  })

  it('preserves a signed inner hearsay tag as payload without marking its wrapper', async () => {
    const owner = 'f'.repeat(64)
    const signed = finalizeEvent({ kind: 1, created_at: 1, tags: [['hearsay']], content: 'signed' }, new Uint8Array(32).fill(2))
    let encryptedInner
    let added
    const db = {
      ownerPubkey: owner,
      async add (event) {
        added = event
        return { ok: true, code: 'stored' }
      }
    }

    await runNostrDbMethod({
      db,
      method: 'addPersonalCopy',
      params: [signed],
      appId: 'real-app',
      signEvent: async template => ({ ...template, id: 'e'.repeat(64), pubkey: owner, sig: '1'.repeat(128) }),
      personalCopyEncrypt: async (kind, plaintext) => {
        encryptedInner = JSON.parse(plaintext)
        return `cipher-${kind}`
      },
      personalCopyObfuscate: async () => 'obfuscated',
      requestPermission: async () => {},
      app: { id: 'app' }
    })

    assert.deepEqual(encryptedInner.tags, [['hearsay']])
    assert.equal(added.tags.some(tag => tag[0] === 'hearsay'), false)
    assert.deepEqual(added.tags.find(tag => tag[0] === 'v'), [
      'v',
      PERSONAL_COPY_PROVENANCE.SIGNED_EVENT
    ])
  })

  it('canonicalizes unsigned self-owned rumors as templates', async () => {
    const owner = 'f'.repeat(64)
    const original = {
      pubkey: owner,
      kind: 30023,
      created_at: 123,
      tags: [['d', 'post'], ['title', 'Secret post']],
      content: 'secret post'
    }
    let encryptedInner
    let added
    const db = {
      ownerPubkey: owner,
      async add (event) {
        added = event
        return { ok: true, code: 'stored' }
      }
    }

    await runNostrDbMethod({
      db,
      method: 'addPersonalCopy',
      params: [original, { context: 'dm:alice' }],
      appId: 'real-app',
      signEvent: async template => ({ ...template, id: 'e'.repeat(64), pubkey: owner, sig: '1'.repeat(128) }),
      personalCopyEncrypt: async (kind, plaintext) => {
        encryptedInner = JSON.parse(plaintext)
        return `cipher-${kind}`
      },
      personalCopyObfuscate: async (value, kind, scope) => `obf:${kind}:${scope}:${value}`,
      requestPermission: async () => {},
      app: { id: 'app' }
    })

    assert.equal('id' in encryptedInner, false)
    assert.equal('pubkey' in encryptedInner, false)
    assert.equal('sig' in encryptedInner, false)
    assert.equal(encryptedInner.kind, 30023)
    assert.equal(encryptedInner.content, 'secret post')
    assert.equal(added.tags.some(tag => tag[0] === 'o' && tag[1] === 'obf:1006:#d:post'), true)
    assert.equal(added.tags.some(tag => tag[0] === 'o' && tag[1] === `obf:1006:.id:${personalCopySourceId(encryptedInner, { wrapperPubkey: owner })}`), true)
    assert.equal(added.tags.some(tag => tag[0] === 'o' && tag[1] === `obf:1006:.pubkey:${owner}`), true)
    assert.deepEqual(added.tags.find(tag => tag[0] === 'v'), [
      'v',
      PERSONAL_COPY_PROVENANCE.DIRECT_RUMOR
    ])
  })

  it('preserves complete verified self-owned events', async () => {
    const original = finalizeEvent({
      kind: 1,
      created_at: 123,
      tags: [],
      content: 'signed by me'
    }, new Uint8Array(32).fill(4))
    let encryptedInner
    let added
    const db = {
      ownerPubkey: original.pubkey,
      async add (event) {
        added = event
        return { ok: true, code: 'stored' }
      }
    }

    await runNostrDbMethod({
      db,
      method: 'addPersonalCopy',
      params: [original],
      appId: 'real-app',
      signEvent: async template => ({
        ...template,
        id: 'e'.repeat(64),
        pubkey: original.pubkey,
        sig: '1'.repeat(128)
      }),
      personalCopyEncrypt: async (kind, plaintext) => {
        encryptedInner = JSON.parse(plaintext)
        return `cipher-${kind}`
      },
      personalCopyObfuscate: async (value, kind, scope) => `obf:${kind}:${scope}:${value}`,
      requestPermission: async () => {},
      app: { id: 'app' }
    })

    assert.deepEqual(encryptedInner, JSON.parse(JSON.stringify(original)))
    assert.deepEqual(added.tags.find(tag => tag[0] === 'v'), [
      'v',
      PERSONAL_COPY_PROVENANCE.SIGNED_EVENT
    ])
  })

  it('rejects unexpected personal-copy inner fields', async () => {
    const owner = 'f'.repeat(64)
    const options = {
      db: { ownerPubkey: owner },
      method: 'addPersonalCopy',
      appId: 'real-app',
      signEvent: async () => { throw new Error('UNEXPECTED_SIGN') },
      personalCopyEncrypt: async () => { throw new Error('UNEXPECTED_ENCRYPT') },
      personalCopyObfuscate: async () => 'obfuscated',
      requestPermission: async () => {},
      app: { id: 'app' }
    }

    await assert.rejects(
      runNostrDbMethod({
        ...options,
        params: [{
          pubkey: 'b'.repeat(64),
          kind: 1,
          created_at: 1,
          tags: [],
          content: 'rumor',
          unexpected: true
        }]
      }),
      /INVALID_PERSONAL_COPY_INNER_EVENT/
    )
  })

  it('delegates query, count, and supports with access permissions', async () => {
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
      ['permission', EVENT_ACCESS_PERMISSION, 1],
      ['query', [{ kinds: [1] }, { appId: 'real-app' }]],
      ['permission', EVENT_ACCESS_PERMISSION, BROAD_EVENT_KIND],
      ['permission', EVENT_ACCESS_PERSONAL_PERMISSION, BROAD_EVENT_KIND],
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
      [EVENT_ACCESS_PERMISSION, 1],
      [EVENT_ACCESS_PERMISSION, 30023],
      [EVENT_ACCESS_PERMISSION, BROAD_EVENT_KIND],
      [EVENT_ACCESS_PERSONAL_PERMISSION, BROAD_EVENT_KIND]
    ])
  })

  it('gates personal-copy queries by explicit or inferred personal inner kinds', async () => {
    const explicitCalls = []
    const explicitDb = {
      async query (...args) {
        explicitCalls.push(['query', args])
        return { results: [{ kind: 1006, tags: [['k', '1']] }] }
      }
    }

    await runNostrDbMethod({
      db: explicitDb,
      method: 'query',
      params: [{ kinds: [1006], '#k': ['1'] }],
      requestPermission: async req => { explicitCalls.push([req.name, req.eKind]) },
      app: { id: 'app' }
    })

    assert.deepEqual(explicitCalls, [
      [EVENT_ACCESS_PERSONAL_PERMISSION, 1],
      ['query', [{ kinds: [1006], '#k': ['1'] }]]
    ])

    const inferredCalls = []
    const inferredDb = {
      async query () {
        inferredCalls.push('query')
        return {
          results: [
            { kind: 1006, tags: [['k', '1']] },
            { kind: 1006, tags: [['k', '30023']] }
          ]
        }
      }
    }

    await runNostrDbMethod({
      db: inferredDb,
      method: 'query',
      params: [{ kinds: [1006] }],
      requestPermission: async req => { inferredCalls.push([req.name, req.eKind]) },
      app: { id: 'app' }
    })

    assert.deepEqual(inferredCalls, [
      'query',
      [EVENT_ACCESS_PERSONAL_PERMISSION, 1],
      [EVENT_ACCESS_PERSONAL_PERMISSION, 30023]
    ])
  })

  it('uses personal broad access for personal-copy counts without explicit #k', async () => {
    const seen = []
    const db = {
      async count (...args) {
        seen.push(['count', args])
        return 3
      }
    }

    assert.equal(await runNostrDbMethod({
      db,
      method: 'count',
      params: [{ kinds: [1006] }],
      requestPermission: async req => { seen.push([req.name, req.eKind]) },
      app: { id: 'app' }
    }), 3)

    assert.deepEqual(seen, [
      [EVENT_ACCESS_PERSONAL_PERMISSION, BROAD_EVENT_KIND],
      ['count', [{ kinds: [1006] }]]
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
      [EVENT_ACCESS_PERMISSION, 1],
      [EVENT_ACCESS_PERMISSION, 30023]
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
      [EVENT_ACCESS_PERMISSION, 1],
      [EVENT_ACCESS_PERMISSION, BROAD_EVENT_KIND],
      [EVENT_ACCESS_PERSONAL_PERMISSION, BROAD_EVENT_KIND]
    ])
  })

  it('authorizes personal-copy subscriptions by explicit or streamed personal inner kind', async () => {
    const explicitCalls = []
    const explicit = createNostrDbSubscriptionAuthorizer({
      app: { id: 'app' },
      requestPermission: async req => { explicitCalls.push([req.name, req.eKind]) },
      params: [{ kinds: [1006], '#k': ['1'] }]
    })
    await explicit.authorizeBeforeStart()
    await explicit.authorizeItem({ result: { kind: 1006, tags: [['k', '1']] } })
    assert.deepEqual(explicitCalls, [
      [EVENT_ACCESS_PERSONAL_PERMISSION, 1]
    ])

    const dynamicCalls = []
    const dynamic = createNostrDbSubscriptionAuthorizer({
      app: { id: 'app' },
      requestPermission: async req => { dynamicCalls.push([req.name, req.eKind]) },
      params: [{ kinds: [1006] }]
    })
    await dynamic.authorizeBeforeStart()
    await dynamic.authorizeItem({ result: { kind: 1006, tags: [['k', '30023']] } })
    await dynamic.authorizeItem({ result: { kind: 1006, tags: [['k', '30023']] } })
    assert.deepEqual(dynamicCalls, [
      [EVENT_ACCESS_PERSONAL_PERMISSION, 30023]
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

  it('selects regular or double signing from the template shape', async () => {
    assert.equal(nostrDbSignMethodForTemplate({ tags: [] }), 'sign_event')
    assert.equal(nostrDbSignMethodForTemplate({ kind: 5, tags: [['e', 'target']] }), 'sign_event')
    assert.equal(nostrDbSignMethodForTemplate({ kind: 1006, tags: [['k', '1']] }), 'sign_event')
    assert.equal(nostrDbSignMethodForTemplate({ kind: 1006, tags: [['k', '1'], ['imkc']] }), 'double_sign_event')
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
    assert.deepEqual(await signEvent({ kind: 1006, tags: [['k', '1']] }), { id: 'sign_event:signed' })
    assert.deepEqual(await signEvent({ kind: 1006, tags: [['k', '1'], ['imkc']] }), { id: 'double_sign_event:signed' })
    assert.equal(calls.length, 4)
    assert.deepEqual(calls.map(call => call.request.method), ['sign_event', 'double_sign_event', 'sign_event', 'double_sign_event'])
    assert.deepEqual(calls.map(call => call.request.context), ['nostrdb_merge', 'nostrdb_merge', 'nostrdb_merge', 'nostrdb_merge'])
    assert.equal(calls.every(call => !('requestPermission' in call.options)), true)
    assert.deepEqual(calls.map(call => call.options.app.napp), ['+app', '+app', '+app', '+app'])
  })

  it('creates a permissionless vault personal-copy decrypt wrapper from k tag', async () => {
    const calls = []
    const decrypt = createNostrDbPersonalCopyDecrypt({
      askVault: async (message, options) => {
        calls.push({ message, options })
        return { payload: 'eyJraW5kIjoxLCJjb250ZW50Ijoic2VjcmV0In0' }
      },
      pubkey: 'f'.repeat(64)
    })

    assert.equal(await decrypt({ tags: [['k', '1']], content: 'ciphertext' }), '{"kind":1,"content":"secret"}')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].message.code, 'NIP07')
    assert.deepEqual(calls[0].message.payload.params, ['f'.repeat(64), '1', '', 'ciphertext'])
    assert.equal(calls[0].message.payload.context, NOSTRDB_PERSONAL_COPY_CONTEXT)
    assert.deepEqual(calls[0].options, { timeout: 120000 })
  })

  it('creates permissionless vault personal-copy encrypt and obfuscate wrappers', async () => {
    const calls = []
    const askVault = async (message, options) => {
      calls.push({ message, options })
      return { payload: message.payload.method === 'obfuscate' ? 'obf' : 'cipher' }
    }
    const pubkey = 'f'.repeat(64)

    const encrypt = createNostrDbPersonalCopyEncrypt({ askVault, pubkey })
    const obfuscate = createNostrDbPersonalCopyObfuscate({ askVault, pubkey })

    assert.equal(await encrypt(1, '{"kind":1}'), 'cipher')
    assert.equal(await obfuscate('topicexample', 1006, '#t'), 'obf')
    assert.deepEqual(calls.map(call => call.message.payload.method), ['nip44v3_encrypt', 'obfuscate'])
    assert.deepEqual(calls[0].message.payload.params, [pubkey, '1', '', 'eyJraW5kIjoxfQ'])
    assert.deepEqual(calls[1].message.payload.params, ['topicexample', '1006', '#t'])
    assert.equal(calls.every(call => call.message.payload.context === NOSTRDB_PERSONAL_COPY_CONTEXT), true)
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
