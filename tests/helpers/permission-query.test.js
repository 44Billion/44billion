import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

const rows = new Map()
const reads = []

mock.module('#services/idb/browser/index.js', {
  namedExports: {
    run: async (method, args) => {
      assert.equal(method, 'get')
      const key = args[0]
      reads.push(key)
      return { result: rows.get(JSON.stringify(key)) }
    }
  }
})

const { hasPermission } = await import('../../src/services/idb/browser/queries/permission.js')

describe('stored permission lookup', () => {
  it('matches only the exact kind and never treats -1 as a wildcard', async () => {
    rows.set(JSON.stringify(['app', 'eventAccess', -1]), { appId: 'app', name: 'eventAccess', eKind: -1 })
    rows.set(JSON.stringify(['app', 'eventAccess', 1]), { appId: 'app', name: 'eventAccess', eKind: 1 })

    assert.equal(await hasPermission('app', 'eventAccess', -1), true)
    assert.equal(await hasPermission('app', 'eventAccess', 1), true)
    rows.delete(JSON.stringify(['app', 'eventAccess', 1]))
    assert.equal(await hasPermission('app', 'eventAccess', 1), false)
    assert.deepEqual(reads, [
      ['app', 'eventAccess', -1],
      ['app', 'eventAccess', 1],
      ['app', 'eventAccess', 1]
    ])
  })

  it('keeps public and personal namespaces independent', async () => {
    rows.clear()
    rows.set(JSON.stringify(['app', 'eventAccess', 9]), { appId: 'app', name: 'eventAccess', eKind: 9 })
    assert.equal(await hasPermission('app', 'eventAccessPersonal', 9), false)
    rows.set(JSON.stringify(['app', 'eventAccessPersonal', 9]), {
      appId: 'app',
      name: 'eventAccessPersonal',
      eKind: 9
    })
    assert.equal(await hasPermission('app', 'eventAccessPersonal', 9), true)
  })
})
