import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'
import {
  FULL_RESET_KEY,
  MAX_FULL_RESET_ATTEMPTS,
  applyPendingLocalDevFullReset,
  readPendingFullReset
} from '../../src/services/local-dev/boot-reset.js'
import {
  readKnownAppSubdomains,
  requestLocalDevFullReset
} from '../../src/services/local-dev/full-reset.js'

function memoryStorage (entries = {}) {
  const data = new Map(Object.entries(entries))
  return {
    get length () { return data.size },
    key: index => [...data.keys()][index] ?? null,
    getItem: key => data.has(String(key)) ? data.get(String(key)) : null,
    setItem: (key, value) => { data.set(String(key), String(value)) },
    removeItem: key => { data.delete(String(key)) },
    clear: () => data.clear(),
    has: key => data.has(String(key))
  }
}

function memoryCaches (names = []) {
  const remaining = new Set(names)
  return {
    keys: async () => [...remaining],
    delete: async name => remaining.delete(name),
    remaining
  }
}

function memoryOpfs (files = []) {
  const entries = new Map(files.map(name => [name, {}]))
  return {
    entries,
    storage: {
      getDirectory: async () => ({
        entries: () => entries.entries(),
        removeEntry: async name => { entries.delete(name) }
      })
    }
  }
}

function openDatabase (indexedDB, name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function databaseNames (indexedDB) {
  return indexedDB.databases().then(databases => (databases || []).map(database => database.name).sort())
}

describe('launcher full dev reset', () => {
  it('reads and validates the pending reset marker', () => {
    const storage = memoryStorage({ [FULL_RESET_KEY]: JSON.stringify({ attempts: 2 }) })
    assert.deepEqual(readPendingFullReset(storage), { attempts: 2 })
    assert.equal(readPendingFullReset(memoryStorage()), null)
    assert.equal(readPendingFullReset(memoryStorage({ [FULL_RESET_KEY]: 'not json' })), null)
    assert.deepEqual(readPendingFullReset(memoryStorage({ [FULL_RESET_KEY]: '{}' })), { attempts: 0 })
  })

  it('wipes the launcher origin before reloading and drops the marker', async () => {
    const indexedDB = new IDBFactory()
    const connection = await openDatabase(indexedDB, '44billion_browser')
    connection.close()
    const localStorage = memoryStorage({ [FULL_RESET_KEY]: JSON.stringify({ attempts: 0 }), session_accountUserPks: '[]' })
    const sessionStorage = memoryStorage({ session_tabWorkspaceKeys: '[]' })
    const caches = memoryCaches(['44billion-chunks'])
    const opfs = memoryOpfs(['nostrdb.bin'])
    const unregistered = []
    const reloads = []
    const warnings = []

    const report = await applyPendingLocalDevFullReset({
      localStorageArea: localStorage,
      sessionStorageArea: sessionStorage,
      indexedDBArea: indexedDB,
      cachesArea: caches,
      navigatorArea: {
        storage: opfs.storage,
        serviceWorker: {
          getRegistrations: async () => [{ unregister: async () => { unregistered.push('sw') } }]
        }
      },
      reload: () => reloads.push('reload'),
      warn: (...args) => warnings.push(args[0])
    })

    assert.deepEqual(await databaseNames(indexedDB), [])
    assert.equal(report.abandoned, false)
    assert.equal(report.attempts, 1)
    assert.deepEqual(report.failures, [])
    assert.deepEqual(report.blocked, [])
    assert.deepEqual(reloads, ['reload'])
    assert.deepEqual(unregistered, ['sw'])
    assert.deepEqual(warnings, [])
    assert.equal(localStorage.has(FULL_RESET_KEY), false)
    assert.equal(localStorage.length, 0)
    assert.equal(sessionStorage.length, 0)
    assert.deepEqual([...caches.remaining], [])
    assert.equal(opfs.entries.size, 0)
  })

  it('keeps the incremented marker when a step fails so the next boot retries', async () => {
    const localStorage = memoryStorage({ [FULL_RESET_KEY]: JSON.stringify({ attempts: 0 }) })
    const sessionStorage = memoryStorage({})
    const reloads = []
    const warnings = []

    const report = await applyPendingLocalDevFullReset({
      localStorageArea: localStorage,
      sessionStorageArea: sessionStorage,
      indexedDBArea: null,
      cachesArea: {
        keys: async () => { throw new Error('CACHE_FAILED') },
        delete: async () => {}
      },
      navigatorArea: {},
      reload: () => reloads.push('reload'),
      warn: (...args) => warnings.push(args[0])
    })

    assert.deepEqual(report.failures.map(failure => failure.step), ['indexedDB', 'caches'])
    assert.match(report.failures[0].message, /IDB_UNAVAILABLE/)
    assert.equal(report.failures[1].message, 'CACHE_FAILED')
    assert.equal(warnings.length, 2)
    assert.deepEqual(reloads, ['reload'])
    // localStorage.clear() did run, so the marker is gone with the rest.
    assert.equal(localStorage.has(FULL_RESET_KEY), false)
  })

  it('abandons an environment whose reset keeps failing instead of reloading forever', async () => {
    const localStorage = memoryStorage({ [FULL_RESET_KEY]: JSON.stringify({ attempts: MAX_FULL_RESET_ATTEMPTS }) })
    const reloads = []
    const warnings = []

    const report = await applyPendingLocalDevFullReset({
      localStorageArea: localStorage,
      reload: () => reloads.push('reload'),
      warn: (...args) => warnings.push(args[0])
    })

    assert.equal(report.abandoned, true)
    assert.deepEqual(reloads, [])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /Abandoning incomplete full reset/)
    assert.equal(localStorage.has(FULL_RESET_KEY), false)
  })

  it('does nothing without a pending marker', async () => {
    const reloads = []
    assert.equal(await applyPendingLocalDevFullReset({
      localStorageArea: memoryStorage(),
      reload: () => reloads.push('reload')
    }), null)
    assert.deepEqual(reloads, [])
  })
})

describe('development environment reset request', () => {
  const mappingStorage = () => memoryStorage({
    session_subdomainToApp_2: JSON.stringify({ userPk: 'user', appId: 'app' }),
    session_subdomainByUserAndApp_user_app: JSON.stringify('0'),
    local_subdomainLifecycle: JSON.stringify({ version: 1, pending: ['5'], assignments: { 0: 'token', 7: 'retired-token' } }),
    session_workspaceKeys: JSON.stringify(['ws'])
  })

  it('lists mapped, assigned and quarantined app subdomains', () => {
    assert.deepEqual(readKnownAppSubdomains(mappingStorage()), ['0', '2', '5', '7'])
    assert.deepEqual(readKnownAppSubdomains(memoryStorage()), [])
    assert.deepEqual(readKnownAppSubdomains(memoryStorage({ local_subdomainLifecycle: 'broken' })), [])
  })

  it('wipes the vault first, then app origins, and reloads through the marker', async () => {
    const localStorage = mappingStorage()
    const cleared = []
    const reloads = []
    const pauses = []
    const requested = []
    const warnings = []
    const urlResets = []

    const result = await requestLocalDevFullReset({
      localStorageArea: localStorage,
      askVault: async (message, options) => {
        requested.push({ message, options })
        return { code: message.code, payload: { databases: ['ez-vault'], failures: [] } }
      },
      pauseInstances: async () => { pauses.push('pause') },
      clearOrigin: async subdomain => {
        cleared.push(subdomain)
        if (subdomain === '5') throw new Error('ORIGIN_CLEANUP_FAILED')
      },
      reload: () => reloads.push('reload'),
      resetUrl: () => urlResets.push('reset-url'),
      warn: (...args) => warnings.push(args[0])
    })

    assert.deepEqual(requested, [{ message: { code: 'LOCAL_DEV_WIPE', payload: null }, options: { timeout: 30000 } }])
    assert.deepEqual(pauses, ['pause'])
    assert.deepEqual(cleared, ['0', '2', '5', '7'])
    assert.deepEqual(result.subdomains, ['0', '2', '5', '7'])
    assert.deepEqual(result.failures.map(failure => failure.subdomain), ['5'])
    assert.equal(warnings.length, 1)
    assert.deepEqual(reloads, ['reload'])
    assert.deepEqual(urlResets, ['reset-url'])
    assert.deepEqual(readPendingFullReset(localStorage), { attempts: 0 })
  })

  it('aborts before clearing anything when the vault cannot be wiped', async () => {
    const localStorage = mappingStorage()
    const cleared = []
    const reloads = []

    await assert.rejects(requestLocalDevFullReset({
      localStorageArea: localStorage,
      askVault: async () => ({ code: 'LOCAL_DEV_WIPE', payload: null, error: new Error('Vault timed out') }),
      pauseInstances: async () => {},
      clearOrigin: async subdomain => { cleared.push(subdomain) },
      reload: () => reloads.push('reload'),
      warn: () => {}
    }), /Vault timed out/)

    assert.deepEqual(cleared, [])
    assert.deepEqual(reloads, [])
    assert.equal(readPendingFullReset(localStorage), null)
  })

  it('requires a connected vault', async () => {
    await assert.rejects(requestLocalDevFullReset({ localStorageArea: memoryStorage() }), /Vault is not connected/)
  })
})
