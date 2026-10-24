import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent } from 'libp2r2p/event'
import { encryptBytes, decryptBytes } from 'libp2r2p/nip44-v3'

import {
  EVENT_ACCESS_PERMISSION,
  EVENT_ACCESS_PERSONAL_PERMISSION,
  ONE_TIME_DELETE_PERMISSION
} from '../../src/helpers/window-message/browser/event-permissions.js'
import {
  buildNostrDbAddOptions,
  buildNostrDbReadOptions,
  classifyNostrDbRead,
  classifyNostrDbWrite,
  createNostrDbMaintenanceSignEvent,
  createNostrDbPersonalCopyDecrypt,
  createNostrDbPersonalCopyEncrypt,
  createNostrDbPersonalCopyObfuscate,
  createNostrDbPersonalCopyObfuscateMany,
  createNostrDbSignEvent,
  explicitFilterKinds,
  isRecoveryArchiveEvent,
  isRecoveryReadQuery,
  NOSTRDB_PERSONAL_COPY_CONTEXT,
  NOSTRDB_MAINTENANCE_CONTEXT,
  NIP07_BATCH_CODE,
  nostrDbSignMethodForTemplate,
  runNostrDbMethod
} from '../../src/helpers/window-message/browser/nostrdb.js'
import { NOSTRDB_RECOVERY_READ } from '../../src/helpers/window-message/nostrdb-protocol.js'
import {
  cancelNostrDbAccesses,
  clearNostrDbAccessSchedulers,
  scheduleNostrDbRead
} from '../../src/services/idb/nostrdb/access-scheduler.js'
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
        mergeReplaceable: false,
        schedulerClass: 'foreground',
        scheduling: { priority: true }
      }],
      appId: 'real-app',
      signEvent: forcedSignEvent,
      requestPermission,
      app: { id: 'app' }
    }), { ok: true })

    assert.deepEqual(calls, ['add'])
    assert.equal(seen.addedEvent, event)
    assert.equal(seen.options.appId, 'real-app')
    assert.equal(seen.options.mergeSource, 'local')
    assert.equal(seen.options.signEvent, forcedSignEvent)
    assert.equal(seen.options.mergeReplaceable, false)
    assert.equal(seen.options.schedulerClass, 'normal')
    assert.equal('scheduling' in seen.options, false)
  })

  it('derives write classes from trusted event shape and ignores payload scheduling', () => {
    const recoverySeed = {
      kind: 30078,
      content: '',
      tags: [['d', `libp2r2p:recovery:seed:${'a'.repeat(64)}`]]
    }
    const recoveryDelete = {
      kind: 5,
      content: '',
      tags: [
        ['a', `30078:${'b'.repeat(64)}:libp2r2p:recovery:grant:${'c'.repeat(64)}`],
        ['k', '30078'],
        ['expiration', '2000000000']
      ]
    }

    assert.equal(classifyNostrDbWrite('remove', []), 'foreground')
    assert.equal(classifyNostrDbWrite('add', [{ kind: 9, tags: [] }]), 'foreground')
    assert.equal(classifyNostrDbWrite('add', [{ kind: 1, tags: [] }]), 'normal')
    assert.equal(classifyNostrDbWrite('add', [{ kind: 'invalid', tags: [] }]), 'normal')
    assert.equal(classifyNostrDbWrite('addPersonalCopy', [{ kind: 9 }, { schedulerClass: 'foreground' }]), 'foreground')
    assert.equal(classifyNostrDbWrite('addPersonalCopy', [{ kind: 1 }, { recovery: true }]), 'normal')
    assert.equal(isRecoveryArchiveEvent(recoverySeed, true), true)
    assert.equal(isRecoveryArchiveEvent(recoveryDelete, true), true)
    assert.equal(classifyNostrDbWrite('addPersonalCopy', [recoverySeed, { recovery: true }]), 'background')
    assert.equal(classifyNostrDbWrite('addPersonalCopy', [recoveryDelete, { recovery: true }]), 'background')
  })

  it('recognizes only structurally valid recovery reads and strips untrusted scheduling', () => {
    const owner = 'a'.repeat(64)
    const recovery = {
      kinds: [1006],
      authors: [owner],
      '#k': ['30078'],
      '#c': ['context'],
      '#v': ['0', '1'],
      '&o': ['mirror'],
      limit: 128
    }
    const exact = { kinds: [1006], authors: [owner], '&o': ['mirror'], limit: 128 }
    assert.equal(isRecoveryReadQuery([recovery]), true)
    assert.equal(isRecoveryReadQuery([exact]), true)
    assert.equal(isRecoveryReadQuery([[recovery, exact]]), false)
    assert.equal(classifyNostrDbRead('query', [recovery, { recovery: true }]), 'background')
    assert.equal(classifyNostrDbRead('query', [recovery]), undefined)
    assert.equal(classifyNostrDbRead('query', [{ kinds: [1], authors: [owner] }, { recovery: true }]), undefined)
    assert.equal(classifyNostrDbRead('count', [recovery, { recovery: true }]), undefined)

    const signal = new AbortController().signal
    assert.deepEqual(buildNostrDbReadOptions({
      appId: 'evil',
      schedulerClass: 'foreground',
      scheduling: { priority: true },
      recovery: true,
      signal: null,
      limit: 10
    }, { appId: 'real', schedulerClass: 'background', signal }), {
      appId: 'real',
      limit: 10,
      schedulerClass: 'background',
      signal
    })
    const recoveryOptions = buildNostrDbReadOptions({}, { schedulerClass: 'background', recoveryRead: true })
    assert.equal(recoveryOptions[NOSTRDB_RECOVERY_READ], true)
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

  it('registers foreground intent before personal-copy encryption completes', async () => {
    const owner = 'a'.repeat(64)
    const encryptionStarted = Promise.withResolvers()
    const releaseEncryption = Promise.withResolvers()
    const readStarted = Promise.withResolvers()
    let readBegan = false
    const db = {
      ownerPubkey: owner,
      async add () { return { ok: true, code: 'stored' } }
    }
    try {
      const write = runNostrDbMethod({
        db,
        method: 'addPersonalCopy',
        params: [{ kind: 9, created_at: 1, tags: [], content: 'trace' }],
        appId: 'chat',
        signEvent: async template => ({ ...template, id: 'e'.repeat(64), pubkey: owner, sig: '1'.repeat(128) }),
        personalCopyEncrypt: async () => {
          encryptionStarted.resolve()
          await releaseEncryption.promise
          return 'cipher'
        },
        personalCopyObfuscate: async value => value,
        requestPermission: async () => {},
        app: { id: 'chat' }
      })
      await encryptionStarted.promise
      const read = scheduleNostrDbRead({
        owner,
        stores: ['events'],
        schedulerClass: 'background',
        appId: 'recovery'
      }, async () => {
        readBegan = true
        readStarted.resolve()
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.equal(readBegan, false)

      releaseEncryption.resolve()
      await write
      await read
      await readStarted.promise
      assert.equal(readBegan, true)
    } finally {
      cancelNostrDbAccesses(owner)
      clearNostrDbAccessSchedulers()
    }
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
      params: [original, { context: 'dm:alice', hearsay: true, recovery: true }],
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
    assert.equal('recovery' in added.options, false)
  })

  it('rejects hearsay for signed or identityless inner events', async () => {
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

  it('delegates all event-store reads without permission', async () => {
    const calls = []
    const requestPermission = async () => { calls.push('permission') }
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
      ['query', [{ kinds: [1] }, { appId: 'real-app' }]],
      ['count', [{ authors: ['a'.repeat(64)] }]],
      ['supports', []]
    ])
  })

  it('schedules a validated recovery query as background and removes the hint', async () => {
    const owner = 'a'.repeat(64)
    let seen
    const db = {
      async query (filter, options) {
        seen = { filter, options }
        return { results: [], meta: {} }
      }
    }
    await runNostrDbMethod({
      db,
      method: 'query',
      params: [{
        kinds: [1006],
        authors: [owner],
        '#k': ['30078'],
        '#c': ['context'],
        '#v': ['0', '1'],
        '&o': ['mirror'],
        limit: 128
      }, { recovery: true }],
      appId: 'real-app',
      requestPermission: async () => {},
      app: { id: 'app' }
    })
    assert.equal(seen.options.schedulerClass, 'background')
    assert.equal(seen.options.appId, 'real-app')
    assert.equal(seen.options[NOSTRDB_RECOVERY_READ], true)
    assert.equal('recovery' in seen.options, false)

    const forged = { [NOSTRDB_RECOVERY_READ]: true }
    await runNostrDbMethod({
      db: {
        async query (filter, options) { seen = { filter, options } }
      },
      method: 'query',
      params: [{ kinds: [1] }, forged],
      appId: 'real-app',
      requestPermission: async () => {},
      app: { id: 'app' }
    })
    assert.equal(seen.options[NOSTRDB_RECOVERY_READ], undefined)
  })

  it('exempts ordinary public writes while preserving personal-wrapper and deletion prompts', async () => {
    const calls = []
    const requestPermission = async req => { calls.push(['permission', req.name, req.eKind]) }
    const db = {
      async add (...args) {
        calls.push(['add', args[0].kind])
        return { ok: true }
      }
    }

    for (const kind of [1, 3560, 26300, 26400]) {
      await runNostrDbMethod({
        db,
        method: 'add',
        params: [{ kind, tags: [] }],
        requestPermission,
        app: { id: 'app' }
      })
    }
    await runNostrDbMethod({
      db,
      method: 'add',
      params: [{ kind: 1006, tags: [['k', '9']] }],
      requestPermission,
      app: { id: 'app' }
    })
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

    assert.deepEqual(calls, [
      ['add', 1],
      ['add', 3560],
      ['add', 26300],
      ['add', 26400],
      ['permission', EVENT_ACCESS_PERSONAL_PERMISSION, 9],
      ['add', 1006],
      ['permission', EVENT_ACCESS_PERMISSION, 30023],
      ['add', 5],
      ['permission', ONE_TIME_DELETE_PERMISSION, 5],
      ['add', 5]
    ])
  })

  it('rejects malformed wrapper writes before prompts or storage', async () => {
    let added = false
    let prompted = false
    await assert.rejects(
      () => runNostrDbMethod({
        db: { async add () { added = true } },
        method: 'add',
        params: [{ kind: 1006, tags: [] }],
        requestPermission: async () => { prompted = true },
        app: { id: 'app' }
      }),
      /PERSONAL_COPY_KIND_REQUIRED/
    )
    assert.equal(added, false)
    assert.equal(prompted, false)
  })

  it('uses one deletion prompt per descriptor across both personal-copy write paths', async () => {
    const deletion = {
      kind: 5,
      created_at: 20,
      tags: [['e', 'b'.repeat(64)], ['k', '9']],
      content: ''
    }
    const capture = async (method, params) => {
      let request
      await assert.rejects(
        () => runNostrDbMethod({
          db: { ownerPubkey: 'a'.repeat(64), async add () {} },
          method,
          params,
          requestPermission: async value => {
            request = value
            throw new Error('stop after permission')
          },
          appId: 'app-id',
          app: { id: 'app' }
        }),
        /stop after permission/
      )
      return request
    }

    const direct = await capture('addPersonalCopy', [deletion, { context: 'dm:peer' }])
    const duplicate = await capture('addPersonalCopy', [deletion, { context: 'dm:peer', dedupeKey: 'forged' }])
    const otherContext = await capture('addPersonalCopy', [deletion, { context: 'dm:other' }])
    assert.equal(direct.name, ONE_TIME_DELETE_PERMISSION)
    assert.equal(direct.remember, false)
    assert.equal(direct.eKind, 5)
    assert.match(direct.dedupeKey, /^app-id:[0-9a-f]{64}$/)
    assert.equal(duplicate.dedupeKey, direct.dedupeKey)
    assert.notEqual(otherContext.dedupeKey, direct.dedupeKey)

    const wrapper = { id: 'c'.repeat(64), kind: 1006, tags: [['k', '5']], created_at: 20, content: 'cipher' }
    const fromWrapper = await capture('add', [wrapper])
    const sameWrapper = await capture('add', [structuredClone(wrapper)])
    assert.equal(fromWrapper.name, ONE_TIME_DELETE_PERMISSION)
    assert.equal(sameWrapper.dedupeKey, fromWrapper.dedupeKey)
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

  it('propagates deletion permission denial before nostrdb add', async () => {
    let added = false
    await assert.rejects(
      () => runNostrDbMethod({
        db: { async add () { added = true } },
        method: 'add',
        params: [{ kind: 5, tags: [['e', 'b'.repeat(64)]] }],
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
        return { payload: new TextEncoder().encode('{"kind":1,"content":"secret"}').buffer }
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
    assert.deepEqual(calls[0].message.payload.params, [pubkey, '1', '', new TextEncoder().encode('{"kind":1}').buffer])
    assert.deepEqual(calls[1].message.payload.params, ['topicexample', '1006', '#t'])
    assert.equal(calls.every(call => call.message.payload.context === NOSTRDB_PERSONAL_COPY_CONTEXT), true)
  })

  it('batches personal-copy obfuscation and falls back only for unsupported vaults', async () => {
    const calls = []
    const pubkey = 'f'.repeat(64)
    const operations = [
      { value: 'topic-batch', kind: 1006, scope: '#t' },
      { value: 'author-batch', kind: 1006, scope: '#p' }
    ]
    const batch = createNostrDbPersonalCopyObfuscateMany({
      pubkey,
      askVault: async (message, options) => {
        calls.push({ message, options })
        return { payload: message.payload.operations.map(operation => `batch:${operation[2]}:${operation[0]}`) }
      }
    })
    assert.deepEqual(await batch(operations), ['batch:#t:topic-batch', 'batch:#p:author-batch'])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].message.code, NIP07_BATCH_CODE)
    assert.equal(calls[0].message.payload.method, 'obfuscateMany')
    assert.deepEqual(calls[0].message.payload.operations, [
      ['topic-batch', '1006', '#t'],
      ['author-batch', '1006', '#p']
    ])

    const fallbackCalls = []
    const fallback = createNostrDbPersonalCopyObfuscateMany({
      pubkey,
      askVault: async message => {
        fallbackCalls.push(message)
        if (message.code === NIP07_BATCH_CODE) return { error: Object.assign(new Error('unsupported'), { code: 'UNSUPPORTED_METHOD' }) }
        return { payload: `individual:${message.payload.params[2]}:${message.payload.params[0]}` }
      }
    })
    assert.deepEqual(await fallback([
      { value: 'fallback-topic', kind: 1006, scope: '#t' },
      { value: 'fallback-author', kind: 1006, scope: '#p' }
    ]), ['individual:#t:fallback-topic', 'individual:#p:fallback-author'])
    assert.deepEqual(fallbackCalls.map(message => message.code), [NIP07_BATCH_CODE, 'NIP07', 'NIP07'])

    const timeoutCalls = []
    const timeout = createNostrDbPersonalCopyObfuscateMany({
      pubkey,
      askVault: async message => {
        timeoutCalls.push(message.code)
        return { error: Object.assign(new Error('timeout'), { code: 'timeout' }) }
      }
    })
    await assert.rejects(timeout([{ value: 'timeout-only', kind: 1006, scope: '#t' }]), /timeout/)
    assert.deepEqual(timeoutCalls, [NIP07_BATCH_CODE])
  })

  it('personal-copy plaintext round-trips through the real NIP-44 v3 signer with query strings and Unicode', async () => {
    const secret = new Uint8Array(32).fill(1)
    const pubkey = finalizeEvent({ kind: 0, created_at: 1, tags: [], content: '' }, secret).pubkey
    const encrypt = createNostrDbPersonalCopyEncrypt({
      pubkey,
      askVault: async ({ payload: { params } }) => ({ payload: encryptBytes(secret, params[0], params[1], new TextEncoder().encode(params[2]), new Uint8Array(params[3])) })
    })
    for (const content of ['https://tabler.io/icons?icon=server-bolt', '😀', 'ação? <>& 😀']) {
      for (const prefix of ['', 'a', 'ab']) {
        const plaintext = JSON.stringify({ content: prefix + content, created_at: 1, kind: 9, tags: [] })
        const ciphertext = await encrypt(9, plaintext)
        const decoded = decryptBytes(secret, pubkey, '9', new Uint8Array(), ciphertext)
        assert.equal(new TextDecoder().decode(decoded), plaintext)
      }
    }
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

describe('remove permission boundary', () => {
  const id = 'ab'.repeat(32)
  it('uses exactly kind 5 permissions, including transport exceptions, without signing', async () => {
    const { eventAccessPermissionRequestsForEvent } = await import('../../src/helpers/window-message/browser/event-permissions.js')
    for (const targets of [[['e', id]], [['a', `30023:${id}:d`]], [['a', `26300:${id}:`]], [['a', `30023:${id}:d`], ['e', id]]]) {
      const requested = []
      let removed = false
      await runNostrDbMethod({
        db: { remove: async received => { assert.deepEqual(received, targets); removed = true; return { ok: true } } },
        method: 'remove', params: [targets],
        requestPermission: async req => requested.push({ name: req.name, eKind: req.eKind, ...(req.remember === undefined ? {} : { remember: req.remember }) }),
        signEvent: () => assert.fail('must not sign')
      })
      assert.deepEqual(requested, eventAccessPermissionRequestsForEvent({ kind: 5, tags: targets }))
      assert.equal(removed, true)
    }
  })
  it('rejects invalid targets before permissions and denies without deleting', async () => {
    const db = { remove: () => assert.fail('must not delete') }
    assert.equal((await runNostrDbMethod({ db, method: 'remove', params: [[['e', id], ['bad', id]]], requestPermission: () => assert.fail('must not prompt') })).code, 'invalid')
    await assert.rejects(runNostrDbMethod({ db, method: 'remove', params: [[['e', id]]], requestPermission: async () => { throw new Error('denied') } }), /denied/)
    await assert.rejects(runNostrDbMethod({ db, method: 'remove', params: [[['e', id]]], requestPermission: async () => {}, assertAccess: () => { throw new Error('revoked') } }), /revoked/)
  })
})
