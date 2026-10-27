import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { IDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb'

let previousIndexedDB
let previousIDBKeyRange

beforeEach(() => {
  previousIndexedDB = globalThis.indexedDB
  previousIDBKeyRange = globalThis.IDBKeyRange
  globalThis.indexedDB = new IDBFactory()
  globalThis.IDBKeyRange = FakeIDBKeyRange
})

afterEach(() => {
  globalThis.indexedDB = previousIndexedDB
  globalThis.IDBKeyRange = previousIDBKeyRange
})

describe('launcher permission schema', () => {
  it('resets v4 permissions to the scope-aware v5 key and preserves other stores', async () => {
    const old = indexedDB.open('44billion_browser', 4)
    old.onupgradeneeded = () => {
      const permissions = old.result.createObjectStore('permissions', { keyPath: ['appId', 'name', 'eKind'] })
      permissions.put({ appId: 'old-app', name: 'eventAccess', eKind: 1 })
      old.result.createObjectStore('chunkState', { keyPath: 'key' }).put({ key: 'preserved', value: 7 })
    }
    const oldDb = await new Promise((resolve, reject) => {
      old.onsuccess = () => resolve(old.result)
      old.onerror = () => reject(old.error)
    })
    oldDb.close()

    const { getDb, run } = await import('../../src/services/idb/browser/index.js?permission-schema')
    const db = await getDb()
    assert.equal(db.version, 5)
    const tx = db.transaction(['permissions', 'chunkState'], 'readonly')
    assert.deepEqual(tx.objectStore('permissions').keyPath, ['appId', 'name', 'eKind', 'scope'])
    const permissions = await new Promise((resolve, reject) => {
      const request = tx.objectStore('permissions').count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const preserved = await new Promise((resolve, reject) => {
      const request = tx.objectStore('chunkState').get('preserved')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    assert.equal(permissions, 0)
    assert.deepEqual(preserved, { key: 'preserved', value: 7 })

    const {
      createOrUpdatePermission,
      deleteAllPermissionsForApp,
      listAllPermissions,
      reconcilePermissionScopes,
      streamAllPermissionsForApp
    } = await import('../../src/services/idb/browser/queries/permission.js?permission-schema')
    const { createPermissionScopeRegistry } = await import('../../src/helpers/window-message/browser/permission-scopes.js?permission-schema')
    await createOrUpdatePermission('old-app', 'eventAccess', 1, '')
    await createOrUpdatePermission('old-app', 'eventAccessPersonal', 9, 'calendar:v1')
    await createOrUpdatePermission('other-app', 'eventAccess', 1, '')
    assert.deepEqual((await listAllPermissions()).map(permission => [
      permission.appId,
      permission.name,
      permission.eKind,
      permission.scope
    ]).sort(), [
      ['old-app', 'eventAccess', 1, ''],
      ['old-app', 'eventAccessPersonal', 9, 'calendar:v1'],
      ['other-app', 'eventAccess', 1, '']
    ])
    await deleteAllPermissionsForApp('old-app')
    await new Promise(resolve => setImmediate(resolve))
    const remaining = []
    for await (const permission of streamAllPermissionsForApp('other-app')) remaining.push(permission)
    assert.deepEqual(remaining, [{ appId: 'other-app', name: 'eventAccess', eKind: 1, scope: '' }])
    await createOrUpdatePermission('other-app', 'eventAccessPersonal', 1, 'supported')
    await createOrUpdatePermission('other-app', 'eventAccessPersonal', 1, 'stale')
    await run('put', [{ appId: 'other-app', name: 'eventAccessPersonal', eKind: 1, scope: 0 }], 'permissions')
    assert.equal(await reconcilePermissionScopes({
      registry: createPermissionScopeRegistry([{ kind: 1, scope: 'supported', labelKey: 'supported scope' }])
    }), 2)
    const reconciled = []
    for await (const permission of streamAllPermissionsForApp('other-app')) reconciled.push(permission)
    assert.deepEqual(reconciled.map(permission => permission.scope).sort(), ['', 'supported'])
    db.close()
  })
})
