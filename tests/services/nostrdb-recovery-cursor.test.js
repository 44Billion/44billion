import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import {
  scanRecoveryCursorChunks
} from '../../src/services/idb/nostrdb/recovery-cursor.js'
import {
  beginNostrDbForegroundIntent,
  cancelNostrDbAccesses,
  clearNostrDbAccessSchedulers,
  nostrDbAccessSchedulerSnapshot,
  scheduleNostrDbRead,
  scheduleNostrDbWrite
} from '../../src/services/idb/nostrdb/access-scheduler.js'

const owner = 'a'.repeat(64)
const databases = []

afterEach(() => {
  cancelNostrDbAccesses(owner)
  clearNostrDbAccessSchedulers()
  for (const db of databases.splice(0)) db.close()
})

async function fixture (count, createdAt = index => 1000 + index) {
  const indexedDB = new IDBFactory()
  const open = indexedDB.open('recovery-cursor', 1)
  open.onupgradeneeded = () => open.result
    .createObjectStore('events', { keyPath: 'i' })
    .createIndex('byTag', 't', { multiEntry: true })
  const db = await new Promise((resolve, reject) => {
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
  databases.push(db)
  const tx = db.transaction('events', 'readwrite')
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve
    tx.onabort = () => reject(tx.error)
  })
  for (let index = 0; index < count; index++) {
    const time = createdAt(index)
    tx.objectStore('events').put({
      i: String(index).padStart(4, '0'),
      t: [['tag', 1, time]]
    })
  }
  await done
  return db
}

function range (until = Infinity) {
  return IDBKeyRange.bound(['tag', 1, 0], ['tag', 1, until])
}

test('scans recovery cursors in chunks of at most 64 newly examined rows', async () => {
  const db = await fixture(200)
  const chunks = []
  const values = []
  const result = await scanRecoveryCursorChunks(db, 'byTag', range(), {
    direction: 'next',
    limit: 200,
    onStored: value => {
      values.push(value.i)
      return true
    },
    onChunk: chunk => chunks.push(chunk)
  })

  assert.deepEqual(chunks.map(chunk => chunk.examined), [64, 64, 64, 8])
  assert.equal(chunks.every(chunk => chunk.examined <= 64), true)
  assert.equal(new Set(values).size, 200)
  assert.deepEqual(result, { chunks: 4, examined: 200, matched: 200 })
})

for (const direction of ['next', 'prev']) {
  test(`resumes exactly inside a shared index-key group in ${direction} direction`, async () => {
    const db = await fixture(150, () => 1000)
    const values = []
    const chunks = []
    const result = await scanRecoveryCursorChunks(db, 'byTag', range(), {
      direction,
      limit: 150,
      onStored: value => {
        values.push(value.i)
        return true
      },
      onChunk: chunk => chunks.push(chunk)
    })
    const expected = Array.from({ length: 150 }, (_, index) => String(index).padStart(4, '0'))
    if (direction === 'prev') expected.reverse()

    assert.deepEqual(values, expected)
    assert.equal(new Set(values).size, 150)
    assert.deepEqual(chunks.map(chunk => chunk.examined), [64, 64, 22])
    assert.deepEqual(chunks.map(chunk => chunk.resumed), [false, true, true])
    assert.deepEqual(result, { chunks: 3, examined: 150, matched: 150 })
  })
}

test('resumes after a checkpoint removed between chunks', async () => {
  const db = await fixture(100)
  const values = []
  let checkpoint
  let removed
  const result = await scanRecoveryCursorChunks(db, 'byTag', range(), {
    direction: 'next',
    limit: 100,
    onStored: value => {
      values.push(value.i)
      checkpoint = value.i
      return true
    },
    onChunk: async chunk => {
      if (chunk.chunkIndex !== 1) return
      removed = checkpoint
      const tx = db.transaction('events', 'readwrite')
      tx.objectStore('events').delete(removed)
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve
        tx.onabort = () => reject(tx.error)
      })
    }
  })

  assert.equal(values.filter(value => value === removed).length, 1)
  assert.equal(new Set(values).size, 100)
  assert.deepEqual(result, { chunks: 2, examined: 100, matched: 100 })
})

test('yields between recovery chunks so foreground can run before the next chunk', async () => {
  const db = await fixture(150)
  const order = []
  let scheduled = 0
  const scheduleRead = operation => scheduleNostrDbRead({
    owner,
    stores: ['events'],
    schedulerClass: 'background',
    appId: 'recovery'
  }, signal => {
    scheduled++
    order.push(`chunk-${scheduled}`)
    return operation(signal)
  })

  await scanRecoveryCursorChunks(db, 'byTag', range(), {
    direction: 'next',
    limit: 128,
    scheduleRead,
    onStored: () => true,
    onChunk: async chunk => {
      if (chunk.chunkIndex !== 1) return
      assert.deepEqual(nostrDbAccessSchedulerSnapshot(owner), { active: 0, waiting: 0 })
      const release = beginNostrDbForegroundIntent({ owner, stores: ['events'], appId: 'chat' })
      try {
        await scheduleNostrDbWrite({
          owner,
          stores: ['events'],
          schedulerClass: 'foreground',
          appId: 'chat'
        }, async () => {
          order.push('write')
        })
      } finally {
        release()
      }
    }
  })

  assert.deepEqual(order, ['chunk-1', 'write', 'chunk-2'])
})

test('aborting between chunks does not return partial results', async () => {
  const db = await fixture(100)
  const controller = new AbortController()
  await assert.rejects(scanRecoveryCursorChunks(db, 'byTag', range(), {
    direction: 'next',
    limit: 100,
    signal: controller.signal,
    onStored: () => true,
    onChunk: chunk => {
      if (chunk.chunkIndex === 1) controller.abort(new DOMException('cancelled', 'AbortError'))
    }
  }), { name: 'AbortError' })
})

test('aborting inside a cursor chunk aborts its readonly transaction', async () => {
  const db = await fixture(100)
  const controller = new AbortController()
  let examined = 0
  const scheduleRead = operation => scheduleNostrDbRead({
    owner,
    stores: ['events'],
    schedulerClass: 'background',
    appId: 'recovery',
    signal: controller.signal
  }, operation)

  await assert.rejects(scanRecoveryCursorChunks(db, 'byTag', range(), {
    direction: 'next',
    limit: 100,
    scheduleRead,
    signal: controller.signal,
    onStored: () => {
      examined++
      if (examined === 10) controller.abort(new DOMException('cancelled', 'AbortError'))
      return true
    }
  }), { name: 'AbortError' })
  assert.equal(examined, 10)
})
