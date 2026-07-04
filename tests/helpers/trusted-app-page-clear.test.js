import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

globalThis.IS_DEVELOPMENT = true
globalThis.window = { location: { origin: 'https://1.44billion.net' } }

const { clearAppData } = await import('../../src/helpers/window-message/trusted-app-page/index.js')

function indexedDbMock ({ failDelete = false } = {}) {
  const deleted = []
  return {
    deleted,
    api: {
      databases: mock.fn(async () => [{ name: 'app-db' }, { name: 'library-db' }, {}]),
      deleteDatabase: mock.fn(name => {
        deleted.push(name)
        const request = {}
        queueMicrotask(() => {
          if (failDelete) {
            request.error = new Error(`delete ${name} failed`)
            request.onerror?.()
          } else {
            request.onsuccess?.()
          }
        })
        return request
      })
    }
  }
}

function documentMock (cookie = 'a=1; b=2') {
  const writes = []
  const document = {}
  Object.defineProperty(document, 'cookie', {
    get: () => cookie,
    set: value => { writes.push(value) }
  })
  return { document, writes }
}

describe('trusted app page clearAppData', () => {
  it('clears app-origin storage and unregisters the service worker', async () => {
    const idb = indexedDbMock()
    const cookie = documentMock()
    const deletedCaches = []
    const removedOpfsEntries = []
    const tells = []
    const parent = {}

    await clearAppData({
      _window: {
        parent,
        indexedDB: idb.api,
        localStorage: { clear: mock.fn() },
        sessionStorage: { clear: mock.fn() }
      },
      _navigator: {
        storage: {
          getDirectory: mock.fn(async () => ({
            entries: async function * () {
              yield ['root-file']
              yield ['subdir']
            },
            removeEntry: mock.fn(async (name, options) => {
              removedOpfsEntries.push({ name, options })
            })
          }))
        },
        serviceWorker: {
          getRegistration: mock.fn(async () => ({ unregister: mock.fn(async () => {}) }))
        }
      },
      _document: cookie.document,
      _caches: {
        keys: mock.fn(async () => ['cache-a', 'cache-b']),
        delete: mock.fn(async name => { deletedCaches.push(name); return true })
      },
      _tell: (to, message, options) => tells.push({ to, message, options })
    })

    assert.deepEqual(idb.deleted, ['app-db', 'library-db'])
    assert.deepEqual(deletedCaches, ['cache-a', 'cache-b'])
    assert.deepEqual(removedOpfsEntries, [
      { name: 'root-file', options: { recursive: true } },
      { name: 'subdir', options: { recursive: true } }
    ])
    assert.equal(cookie.writes.length, 2)
    assert(cookie.writes.every(value => value.includes('max-age=0') && value.includes('path=/')))
    assert.equal(tells.length, 1)
    assert.equal(tells[0].to, parent)
    assert.equal(tells[0].message.code, 'DATA_CLEARED')
  })

  it('skips unavailable optional storage APIs', async () => {
    const tells = []

    await clearAppData({
      _window: { parent: {}, localStorage: {}, sessionStorage: {} },
      _navigator: {},
      _document: {},
      _caches: null,
      _tell: (to, message) => tells.push(message)
    })

    assert.deepEqual(tells.map(message => message.code), ['DATA_CLEARED'])
  })

  it('reports DATA_CLEAR_ERROR after trying later clear steps', async () => {
    const idb = indexedDbMock()
    const sessionClear = mock.fn()
    const cacheDelete = mock.fn(async () => true)
    const opfsRemove = mock.fn(async () => {})
    const unregister = mock.fn(async () => {})
    const tells = []

    await clearAppData({
      _window: {
        parent: {},
        indexedDB: idb.api,
        localStorage: { clear: mock.fn(() => { throw new Error('local failed') }) },
        sessionStorage: { clear: sessionClear }
      },
      _navigator: {
        storage: {
          getDirectory: async () => ({
            entries: async function * () { yield ['opfs-file'] },
            removeEntry: opfsRemove
          })
        },
        serviceWorker: {
          getRegistration: async () => ({ unregister })
        }
      },
      _document: documentMock('').document,
      _caches: {
        keys: async () => ['cache-a'],
        delete: cacheDelete
      },
      _tell: (to, message) => tells.push(message)
    })

    assert.equal(sessionClear.mock.callCount(), 1)
    assert.equal(cacheDelete.mock.callCount(), 1)
    assert.equal(opfsRemove.mock.callCount(), 1)
    assert.equal(unregister.mock.callCount(), 1)
    assert.equal(tells.length, 1)
    assert.equal(tells[0].code, 'DATA_CLEAR_ERROR')
    assert.equal(tells[0].error.errors.length, 1)
    assert.deepEqual(tells[0].payload.failures.map(failure => failure.step), ['localStorage'])
  })
})
