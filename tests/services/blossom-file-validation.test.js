import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb'

test('persists a Blossom validation marker and removes it with the file cache', async () => {
  const previousIndexedDB = globalThis.indexedDB
  const previousIDBKeyRange = globalThis.IDBKeyRange
  const previousLocalStorage = globalThis.localStorage
  const storage = new Map()

  globalThis.indexedDB = new IDBFactory()
  globalThis.IDBKeyRange = FakeIDBKeyRange
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value)
  }

  try {
    const {
      deleteFileChunksFromDb,
      getBlossomFileValidation,
      isValidBlossomFileValidation,
      markBlossomFileValidated
    } = await import('../../src/services/idb/browser/queries/file-chunk.js?blossom-validation')
    const { getDb } = await import('../../src/services/idb/browser/index.js')
    const appId = 'app'
    const rootHash = 'a'.repeat(64)

    await markBlossomFileValidated(appId, rootHash, {
      totalChunks: 2,
      byteLength: 51001,
      validatedAt: 123
    })
    const record = await getBlossomFileValidation(appId, rootHash)
    assert.equal(isValidBlossomFileValidation(record, {
      appId,
      rootHash,
      totalChunks: 2
    }), true)
    assert.equal(isValidBlossomFileValidation(record, {
      appId,
      rootHash,
      totalChunks: 1
    }), false)
    assert.equal(isValidBlossomFileValidation({ ...record, version: 1 }, {
      appId,
      rootHash,
      totalChunks: 2
    }), false)

    await deleteFileChunksFromDb(appId, rootHash)
    assert.equal(await getBlossomFileValidation(appId, rootHash), null)
    ;(await getDb()).close()
  } finally {
    globalThis.indexedDB = previousIndexedDB
    globalThis.IDBKeyRange = previousIDBKeyRange
    globalThis.localStorage = previousLocalStorage
  }
})
