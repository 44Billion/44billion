import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  enqueueVaultAcceptedMessage,
  flushVaultAcceptedMessageQueue,
  readVaultAcceptedMessageQueue,
  vaultAcceptedMessageQueueInternals
} from '../../src/helpers/window-message/browser/vault-accepted-message-queue.js'

const { NOSTRDB_APP_BACKFILL_CODE } = vaultAcceptedMessageQueueInternals

function createStorage () {
  const data = new Map()
  return {
    data,
    getItem: key => data.get(String(key)) ?? null,
    removeItem: key => { data.delete(String(key)) },
    setItem: (key, value) => { data.set(String(key), String(value)) }
  }
}

function appBackfillMessage (ownerPubkey, appId) {
  return {
    code: NOSTRDB_APP_BACKFILL_CODE,
    payload: { ownerPubkey, appId }
  }
}

describe('durable vault accepted-message queue', () => {
  let storage

  beforeEach(() => {
    storage = createStorage()
  })

  it('rejects unknown message codes', () => {
    assert.equal(enqueueVaultAcceptedMessage({
      code: 'UNKNOWN',
      payload: {}
    }, { storage, now: 1000 }), false)
    assert.deepEqual(readVaultAcceptedMessageQueue({ storage, now: 1000 }), [])
  })

  it('validates and normalizes NostrDB app backfill payloads', () => {
    const ownerPubkey = 'a'.repeat(64)

    assert.equal(enqueueVaultAcceptedMessage(appBackfillMessage('A'.repeat(64), 'app-1'), { storage, now: 1000 }), true)
    assert.equal(enqueueVaultAcceptedMessage(appBackfillMessage('not-hex', 'app-2'), { storage, now: 1000 }), false)
    assert.equal(enqueueVaultAcceptedMessage(appBackfillMessage(ownerPubkey, ''), { storage, now: 1000 }), false)

    assert.deepEqual(readVaultAcceptedMessageQueue({ storage, now: 1000 }), [{
      code: NOSTRDB_APP_BACKFILL_CODE,
      payload: { ownerPubkey, appId: 'app-1' },
      createdAt: 1000,
      lastAttemptAt: 0
    }])
  })

  it('dedupes queued requests using configured fields', () => {
    const ownerPubkey = 'b'.repeat(64)

    assert.equal(enqueueVaultAcceptedMessage(appBackfillMessage(ownerPubkey, 'app-1'), { storage, now: 1000 }), true)
    assert.equal(enqueueVaultAcceptedMessage(appBackfillMessage(ownerPubkey, 'app-1'), { storage, now: 2000 }), true)

    assert.deepEqual(readVaultAcceptedMessageQueue({ storage, now: 2000 }), [{
      code: NOSTRDB_APP_BACKFILL_CODE,
      payload: { ownerPubkey, appId: 'app-1' },
      createdAt: 1000,
      lastAttemptAt: 0
    }])
  })

  it('prunes old items and keeps only the newest capped set', () => {
    const {
      KEY,
      MAX_ITEMS,
      SIX_MONTHS_MS
    } = vaultAcceptedMessageQueueInternals
    const now = SIX_MONTHS_MS + 10_000

    storage.setItem(KEY, JSON.stringify([
      {
        code: NOSTRDB_APP_BACKFILL_CODE,
        payload: { ownerPubkey: 'f'.repeat(64), appId: 'old-app' },
        createdAt: now - SIX_MONTHS_MS - 1,
        lastAttemptAt: 0
      },
      ...Array.from({ length: MAX_ITEMS + 2 }, (_, i) => ({
        code: NOSTRDB_APP_BACKFILL_CODE,
        payload: {
          ownerPubkey: i.toString(16).padStart(64, '0'),
          appId: `app-${i}`
        },
        createdAt: now - SIX_MONTHS_MS + i + 1,
        lastAttemptAt: 0
      }))
    ]))

    const queue = readVaultAcceptedMessageQueue({ storage, now })

    assert.equal(queue.length, MAX_ITEMS)
    assert.equal(queue[0].payload.appId, 'app-2')
    assert.equal(queue.at(-1).payload.appId, `app-${MAX_ITEMS + 1}`)
    assert.equal(queue.some(item => item.payload.appId === 'old-app'), false)
  })

  it('removes accepted and rejected items after a vault reply', async () => {
    const acceptedOwner = 'c'.repeat(64)
    const rejectedOwner = 'd'.repeat(64)
    const calls = []

    enqueueVaultAcceptedMessage(appBackfillMessage(acceptedOwner, 'accepted-app'), { storage, now: 1000 })
    enqueueVaultAcceptedMessage(appBackfillMessage(rejectedOwner, 'rejected-app'), { storage, now: 1000 })

    const flushed = await flushVaultAcceptedMessageQueue({
      vaultPort: {},
      storage,
      now: () => 10_000,
      ask: async (port, message) => {
        calls.push(message)
        return { payload: { accepted: message.payload.appId === 'accepted-app' } }
      }
    })

    assert.equal(flushed, true)
    assert.deepEqual(calls.map(message => message.code), [NOSTRDB_APP_BACKFILL_CODE, NOSTRDB_APP_BACKFILL_CODE])
    assert.deepEqual(calls.map(message => message.payload.appId), ['accepted-app', 'rejected-app'])
    assert.deepEqual(readVaultAcceptedMessageQueue({ storage, now: 10_000 }), [])
  })

  it('keeps timed-out or unanswered items and throttles immediate retries', async () => {
    const ownerPubkey = 'e'.repeat(64)
    const { RETRY_THROTTLE_MS } = vaultAcceptedMessageQueueInternals
    let calls = 0

    enqueueVaultAcceptedMessage(appBackfillMessage(ownerPubkey, 'app-1'), { storage, now: 1000 })

    const firstFlush = await flushVaultAcceptedMessageQueue({
      vaultPort: {},
      storage,
      now: () => 5000,
      ask: async () => {
        calls++
        return { error: new Error('timeout') }
      }
    })

    assert.equal(firstFlush, false)
    assert.equal(calls, 1)
    assert.deepEqual(readVaultAcceptedMessageQueue({ storage, now: 5000 }), [{
      code: NOSTRDB_APP_BACKFILL_CODE,
      payload: { ownerPubkey, appId: 'app-1' },
      createdAt: 1000,
      lastAttemptAt: 5000
    }])

    const secondFlush = await flushVaultAcceptedMessageQueue({
      vaultPort: {},
      storage,
      now: () => 5000 + RETRY_THROTTLE_MS - 1,
      ask: async () => {
        calls++
        return { payload: { accepted: true } }
      }
    })

    assert.equal(secondFlush, false)
    assert.equal(calls, 1)
    assert.equal(readVaultAcceptedMessageQueue({ storage, now: 5000 + RETRY_THROTTLE_MS - 1 }).length, 1)
  })

  it('keeps transport-error items without blocking later queued items', async () => {
    const failingOwner = 'e'.repeat(64)
    const acceptedOwner = 'f'.repeat(64)
    const calls = []

    enqueueVaultAcceptedMessage(appBackfillMessage(failingOwner, 'failing-app'), { storage, now: 1000 })
    enqueueVaultAcceptedMessage(appBackfillMessage(acceptedOwner, 'accepted-app'), { storage, now: 1000 })

    const flushed = await flushVaultAcceptedMessageQueue({
      vaultPort: {},
      storage,
      now: () => 9000,
      ask: async (port, message) => {
        calls.push(message.payload.appId)
        if (message.payload.appId === 'failing-app') throw new Error('port closed')
        return { payload: { accepted: true } }
      }
    })

    assert.equal(flushed, true)
    assert.deepEqual(calls, ['failing-app', 'accepted-app'])
    assert.deepEqual(readVaultAcceptedMessageQueue({ storage, now: 9000 }), [{
      code: NOSTRDB_APP_BACKFILL_CODE,
      payload: { ownerPubkey: failingOwner, appId: 'failing-app' },
      createdAt: 1000,
      lastAttemptAt: 9000
    }])
  })

  it('migrates legacy app-backfill queue rows into the generic queue', () => {
    const {
      KEY,
      LEGACY_APP_BACKFILL_KEY
    } = vaultAcceptedMessageQueueInternals
    const ownerPubkey = 'a'.repeat(64)
    const otherOwnerPubkey = 'b'.repeat(64)

    storage.setItem(KEY, JSON.stringify([{
      code: NOSTRDB_APP_BACKFILL_CODE,
      payload: { ownerPubkey, appId: 'app-1' },
      createdAt: 2000,
      lastAttemptAt: 0
    }]))
    storage.setItem(LEGACY_APP_BACKFILL_KEY, JSON.stringify([
      {
        ownerPubkey: ownerPubkey.toUpperCase(),
        appId: 'app-1',
        createdAt: 1000,
        lastAttemptAt: 500
      },
      {
        ownerPubkey: otherOwnerPubkey,
        appId: 'app-2',
        createdAt: 1500,
        lastAttemptAt: 0
      }
    ]))

    const queue = readVaultAcceptedMessageQueue({ storage, now: 3000 })

    assert.deepEqual(queue, [
      {
        code: NOSTRDB_APP_BACKFILL_CODE,
        payload: { ownerPubkey, appId: 'app-1' },
        createdAt: 1000,
        lastAttemptAt: 500
      },
      {
        code: NOSTRDB_APP_BACKFILL_CODE,
        payload: { ownerPubkey: otherOwnerPubkey, appId: 'app-2' },
        createdAt: 1500,
        lastAttemptAt: 0
      }
    ])
    assert.equal(storage.data.has(LEGACY_APP_BACKFILL_KEY), false)
    assert.equal(storage.data.has(KEY), true)
  })
})
