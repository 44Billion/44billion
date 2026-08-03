import assert from 'node:assert/strict'
import { before, describe, it, mock } from 'node:test'

const run = mock.fn((_method, _args, _storeName, _indexName, { p, txMode }) => {
  assert.equal(txMode, 'readwrite')
  const cursor = {
    key: ['app', 'root', 0],
    value: { fx: 'root' },
    delete: mock.fn(),
    continue: () => queueMicrotask(() => p.resolve({ result: null, tx: { abort () {} } }))
  }
  queueMicrotask(() => p.resolve({ result: cursor, tx: { abort () {} } }))
  return p.promise
})
const applyAssetBudgetDelta = mock.fn()

mock.module('#services/idb/browser/index.js', {
  namedExports: { run }
})
mock.module('#services/app-asset-budget/index.js', {
  namedExports: {
    applyAssetBudgetDelta,
    ensureAssetBudgetInitialized: async () => {},
    ensureCanStoreAppAssetBytes: async () => {}
  }
})

globalThis.IDBKeyRange ??= { bound: (...values) => values }

let deleteFileChunksFromDb
let deleteStaleFileChunksFromDb
before(async () => {
  ({ deleteFileChunksFromDb, deleteStaleFileChunksFromDb } = await import(
    '../../src/services/idb/browser/queries/file-chunk.js'
  ))
})

describe('file chunk deletion transactions', () => {
  it('opens a writable cursor when deleting all chunks', async () => {
    await deleteFileChunksFromDb('app')
    assert.equal(run.mock.callCount(), 1)
  })

  it('opens a writable cursor when deleting stale chunks', async () => {
    run.mock.resetCalls()
    await deleteStaleFileChunksFromDb('app', [])
    assert.equal(run.mock.callCount(), 1)
  })
})
