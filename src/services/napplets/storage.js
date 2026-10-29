import { NAPPLET_DATABASE, NAPPLET_INSTALLATIONS_STORE, NAPPLET_STATE_PREFIX } from '#constants/storage-schema.js'

// Connections are short-lived so reset/deletion never waits on an idle host.
export async function installationOperation (mode, operation, idb = globalThis.indexedDB) {
  const db = await new Promise((resolve, reject) => {
    const request = idb.open(NAPPLET_DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(NAPPLET_INSTALLATIONS_STORE, { keyPath: 'appId' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  db.onversionchange = () => db.close()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(NAPPLET_INSTALLATIONS_STORE, mode)
      const request = operation(tx.objectStore(NAPPLET_INSTALLATIONS_STORE))
      tx.oncomplete = () => resolve(request.result)
      tx.onerror = tx.onabort = () => reject(tx.error || request.error || new Error('Napplet storage transaction failed'))
    })
  } finally { db.close() }
}

export const getInstallation = (appId, idb) => installationOperation('readonly', store => store.get(appId), idb)
export const listInstallations = idb => installationOperation('readonly', store => store.getAll(), idb)
export const saveInstallation = (record, idb) => installationOperation('readwrite', store => store.put(record), idb)
export const addInstallation = (record, idb) => installationOperation('readwrite', store => store.add(record), idb)
export const deleteInstallation = (appId, idb) => installationOperation('readwrite', store => store.delete(appId), idb)

export function nappletStateKey (userPk, appId) {
  return `${NAPPLET_STATE_PREFIX}${encodeURIComponent(userPk)}_${appId}`
}

export function clearNappletState (appId, storage = globalThis.localStorage, userPk) {
  if (userPk !== undefined) { storage.removeItem(nappletStateKey(userPk, appId)); return }
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index)
    if (key?.startsWith(NAPPLET_STATE_PREFIX) && key.endsWith(`_${appId}`)) storage.removeItem(key)
  }
}

// The runtime supplies already-scoped keys. One JSON record adds the host's
// account + publisher/catalog boundary, which Kehto's default browser store lacks.
export function createNappletStatePersistence (userPk, appId, storage = globalThis.localStorage) {
  const storageKey = nappletStateKey(userPk, appId)
  const read = () => {
    const value = JSON.parse(storage.getItem(storageKey) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid napplet state')
    return new Map(Object.entries(value))
  }
  const write = map => storage.setItem(storageKey, JSON.stringify(Object.fromEntries(map)))
  return {
    get: key => read().get(key) ?? null,
    set (key, value) {
      try { const map = read(); map.set(key, value); write(map); return true } catch { return false }
    },
    remove (key) { const map = read(); map.delete(key); write(map) },
    clear (prefix) { write(new Map([...read()].filter(([key]) => !key.startsWith(prefix)))) },
    keys: prefix => [...read().keys()].filter(key => key.startsWith(prefix)),
    calculateBytes: (prefix, excludeKey) => [...read()].reduce((bytes, [key, value]) => bytes + (key.startsWith(prefix) && key !== excludeKey ? new TextEncoder().encode(key + value).length : 0), 0)
  }
}
