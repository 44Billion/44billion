export const getDb = (db => async () => (db ??= await initDb()))()
const initDb = () => {
  const p = Promise.withResolvers()
  const req = indexedDB.open('44billion_browser', 1)
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
    }
    console.log(`[${db.name}DB v${db.version}] ${store.name} store is ready`)
    if (!db.objectStoreNames.contains('bundles')) {
      store = db.createObjectStore('bundles', { keyPath: ['c', 'p', 'd'] })
    } else {
      store = tx.objectStore('bundles')
    }
    console.log(`[${db.name}DB v${db.version}] ${store.name} store is ready`)
  }
  return p.promise
}

export async function run (method, args = [], storeName, indexName, { p = Promise.withResolvers(), tx, txMode = tx?.mode, storeOrIndex } = {}) {
  if (!tx) {
    const db = await getDb()
    // one may pre-select it if it wants to use many different methods in a row
    txMode ??= ['get', 'getKey', 'count'].includes(method) ? 'readonly' : 'readwrite'
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
