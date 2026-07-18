export const getDb = (db => async () => (db ??= await initDb()))()
const initDb = () => {
  const p = Promise.withResolvers()
  const req = indexedDB.open('44billion_browser', 4)
  req.onerror = () => p.reject(req.error)
  req.onsuccess = () => {
    const db = req.result
    db.onversionchange = () => {
      db.close()
      location.reload(true)
    }
    db.onerror = () => {
      console.log(`[${db.name}DB v${db.version}] IndexedDB error. Code: ${req.errorCode} - ${req.error.stack}`)
    }
    p.resolve(db)
  }
  req.onupgradeneeded = e => {
    const db = e.target.result
    const tx = e.target.transaction
    let store
    if (!db.objectStoreNames.contains('fileChunks')) {
      store = db.createObjectStore('fileChunks', { keyPath: ['appId', 'fx', 'pos'] })
    } else {
      store = tx.objectStore('fileChunks')
      if (e.oldVersion > 0 && e.oldVersion < 3) store.clear()
    }
    console.log(`[${db.name}DB v${db.version}] ${store.name} store is ready`)
    // Migration: delete old 'bundles' store
    if (db.objectStoreNames.contains('bundles')) {
      db.deleteObjectStore('bundles')
      console.log(`[${db.name}DB v${db.version}] deleted old 'bundles' store`)
    }
    if (!db.objectStoreNames.contains('siteManifests')) {
      store = db.createObjectStore('siteManifests', { keyPath: ['c', 'p', 'd'] })
    } else {
      store = tx.objectStore('siteManifests')
      if (e.oldVersion > 0 && e.oldVersion < 3) store.clear()
    }
    console.log(`[${db.name}DB v${db.version}] ${store.name} store is ready`)
    if (!db.objectStoreNames.contains('permissions')) {
      store = db.createObjectStore('permissions', { keyPath: ['appId', 'name', 'eKind'] })
    } else {
      store = tx.objectStore('permissions')
    }
    if (e.oldVersion > 0 && e.oldVersion < 3) {
      const legacyListingKinds = new Set([37348, 37349, 37350])
      const cursorRequest = store.openCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor) return
        if (legacyListingKinds.has(cursor.value?.eKind)) cursor.delete()
        cursor.continue()
      }
      try { globalThis.localStorage?.removeItem('44billion:app-asset-budget:v1') } catch (_) {}
    }
    console.log(`[${db.name}DB v${db.version}] ${store.name} store is ready`)

    if (!db.objectStoreNames.contains('chunkPayloads')) {
      store = db.createObjectStore('chunkPayloads', { keyPath: 'contentHash' })
    } else {
      store = tx.objectStore('chunkPayloads')
    }
    console.log(`[${db.name}DB v${db.version}] ${store.name} store is ready`)

    if (!db.objectStoreNames.contains('chunkCopies')) {
      store = db.createObjectStore('chunkCopies', { keyPath: ['owner', 'root', 'index'] })
    } else {
      store = tx.objectStore('chunkCopies')
    }
    if (!store.indexNames.contains('byRootIndex')) store.createIndex('byRootIndex', ['root', 'index'])
    if (!store.indexNames.contains('byOwnerEvent')) store.createIndex('byOwnerEvent', ['owner', 'eventId'], { unique: true })
    if (!store.indexNames.contains('byOwnerRoot')) store.createIndex('byOwnerRoot', ['owner', 'root'])
    if (!store.indexNames.contains('byContentHash')) store.createIndex('byContentHash', 'contentHash')
    console.log(`[${db.name}DB v${db.version}] ${store.name} store is ready`)

    if (!db.objectStoreNames.contains('chunkPayloadRoots')) {
      store = db.createObjectStore('chunkPayloadRoots', { keyPath: ['owner', 'root', 'contentHash'] })
    } else {
      store = tx.objectStore('chunkPayloadRoots')
    }
    if (!store.indexNames.contains('byOwnerRoot')) store.createIndex('byOwnerRoot', ['owner', 'root'])
    if (!store.indexNames.contains('byContentHash')) store.createIndex('byContentHash', 'contentHash')
    console.log(`[${db.name}DB v${db.version}] ${store.name} store is ready`)

    if (!db.objectStoreNames.contains('chunkRoots')) {
      store = db.createObjectStore('chunkRoots', { keyPath: ['owner', 'root'] })
    } else {
      store = tx.objectStore('chunkRoots')
    }
    if (!store.indexNames.contains('byPurge')) store.createIndex('byPurge', ['referenced', 'lastActivityAt'])
    console.log(`[${db.name}DB v${db.version}] ${store.name} store is ready`)

    if (!db.objectStoreNames.contains('chunkState')) {
      store = db.createObjectStore('chunkState', { keyPath: 'key' })
    } else {
      store = tx.objectStore('chunkState')
    }
    console.log(`[${db.name}DB v${db.version}] ${store.name} store is ready`)
  }
  return p.promise
}

export async function run (method, args = [], storeName, indexName, { db, p = Promise.withResolvers(), tx, txMode = tx?.mode, storeOrIndex } = {}) {
  if (!tx) {
    db ??= await getDb()
    // one may pre-select it if it wants to use many different methods in a row
    txMode ??= ['get', 'getKey', 'count', 'openCursor', 'openKeyCursor'].includes(method) ? 'readonly' : 'readwrite'
    tx = db.transaction([storeName], txMode)
  }
  if (!storeOrIndex) {
    const store = tx.objectStore(storeName)
    storeOrIndex = indexName ? store.index(indexName) : store
  }

  const req = storeOrIndex[method](...args)
  req.onsuccess = () => { p.resolve({ result: req.result, tx, storeOrIndex }) } // don't add p
  req.onerror = () => { p.reject(req.error); tx.abort() }
  return p.promise
}
