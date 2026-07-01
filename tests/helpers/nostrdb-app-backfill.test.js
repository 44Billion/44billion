import { beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

const flushes = []

mock.module('#zones/vault-modal/index.js', {
  namedExports: {
    flushQueuedVaultAcceptedMessages: () => {
      flushes.push(true)
      return Promise.resolve(false)
    }
  }
})

const { base16ToBase62 } = await import('#helpers/base62.js')
const {
  readVaultAcceptedMessageQueue,
  vaultAcceptedMessageQueueInternals
} = await import('../../src/helpers/window-message/browser/vault-accepted-message-queue.js')
const {
  requestNostrDbAppBackfillForWorkspace,
  requestNostrDbAppBackfillsForWorkspace
} = await import('../../src/components/zones/screen/nostrdb-app-backfill.js')

const data = new Map()

globalThis.localStorage = {
  getItem: key => data.get(String(key)) ?? null,
  removeItem: key => { data.delete(String(key)) },
  setItem: (key, value) => { data.set(String(key), String(value)) }
}

describe('nostrdb app backfill launcher helper', () => {
  beforeEach(() => {
    flushes.length = 0
    data.clear()
  })

  function storageFor ({ wsKey = 'ws1', userPk, defaultUserPk }) {
    return {
      session_defaultUserPk$: () => defaultUserPk,
      [`session_workspaceByKey_${wsKey}_userPk$`]: () => userPk
    }
  }

  it('queues app backfill requests with hex owner pubkeys', () => {
    const ownerPubkey = 'a'.repeat(64)
    const userPk = base16ToBase62(ownerPubkey)

    assert.equal(requestNostrDbAppBackfillForWorkspace({
      storage: storageFor({ userPk }),
      wsKey: 'ws1',
      appId: 'app-1'
    }), true)

    const queue = readVaultAcceptedMessageQueue()
    assert.deepEqual(queue, [{
      code: 'NOSTRDB_APP_BACKFILL',
      payload: { ownerPubkey, appId: 'app-1' },
      createdAt: queue[0].createdAt,
      lastAttemptAt: 0
    }])
    assert.deepEqual(flushes, [true])
  })

  it('skips the default placeholder user', () => {
    const userPk = base16ToBase62('b'.repeat(64))

    assert.equal(requestNostrDbAppBackfillForWorkspace({
      storage: storageFor({ userPk, defaultUserPk: userPk }),
      wsKey: 'ws1',
      appId: 'app-1'
    }), false)

    assert.deepEqual(readVaultAcceptedMessageQueue(), [])
    assert.deepEqual(flushes, [])
  })

  it('requests every app in a workspace batch', () => {
    const userPk = base16ToBase62('c'.repeat(64))

    assert.equal(requestNostrDbAppBackfillsForWorkspace({
      storage: storageFor({ userPk }),
      wsKey: 'ws1',
      appIds: ['app-1', 'app-2']
    }), 2)

    assert.deepEqual(readVaultAcceptedMessageQueue().map(item => item.payload.appId), ['app-1', 'app-2'])
    assert.deepEqual(flushes, [true, true])
  })

  it('dedupes queued app requests', () => {
    const userPk = base16ToBase62('d'.repeat(64))
    const storage = storageFor({ userPk })

    requestNostrDbAppBackfillForWorkspace({ storage, wsKey: 'ws1', appId: 'app-1' })
    requestNostrDbAppBackfillForWorkspace({ storage, wsKey: 'ws1', appId: 'app-1' })

    assert.equal(readVaultAcceptedMessageQueue().length, 1)
    assert.equal(data.has(vaultAcceptedMessageQueueInternals.KEY), true)
  })
})
