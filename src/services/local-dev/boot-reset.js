// Development-only full environment reset, launcher half.
//
// The launcher cannot delete another origin's storage, so the confirmed menu
// action wipes the vault and every app origin first and leaves the marker
// below behind. The next boot applies it before the storage guard, the storage
// audit or any IndexedDB consumer initializes, which is the only moment when
// the launcher origin's databases can be deleted while nothing holds them open.
export const FULL_RESET_KEY = 'local_devFullReset'
export const MAX_FULL_RESET_ATTEMPTS = 2
const DELETE_TIMEOUT_MS = 5000

export function readPendingFullReset (localStorageArea = globalThis.localStorage) {
  let value
  try {
    value = JSON.parse(localStorageArea?.getItem?.(FULL_RESET_KEY) || 'null')
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const attempts = value.attempts
  return { attempts: Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 0 }
}

export function writePendingFullReset (localStorageArea = globalThis.localStorage, attempts = 0) {
  try {
    localStorageArea?.setItem?.(FULL_RESET_KEY, JSON.stringify({ attempts }))
  } catch {
    // A storage area that refuses writes also cannot hold the marker this wipe
    // is about to erase; the click handler still clears everything reachable.
  }
}

export function clearPendingFullReset (localStorageArea = globalThis.localStorage) {
  try {
    localStorageArea?.removeItem?.(FULL_RESET_KEY)
  } catch {}
}

function deleteDatabase (indexedDBArea, name, timeoutMs) {
  return new Promise((resolve, reject) => {
    let request
    try {
      request = indexedDBArea.deleteDatabase(name)
    } catch (error) {
      reject(error)
      return
    }
    // `blocked` only means another connection is still closing (another
    // launcher tab). Keep waiting for `success`; the timeout bounds our wait
    // and still reports the unconfirmed delete.
    let blocked = false
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result?.error) reject(result.error)
      else resolve(result)
    }
    const timer = setTimeout(() => finish({ name, blocked: true }), timeoutMs)
    request.onblocked = () => { blocked = true }
    request.onsuccess = () => finish({ name, blocked })
    request.onerror = () => finish({ error: request.error || new Error(`IDB_DELETE_FAILED: ${name}`) })
  })
}

// Deletes every database in this origin, not just the ones this build knows:
// the point of the full reset is to leave nothing behind for the next boot.
export async function clearLauncherIndexedDb (indexedDBArea, { timeoutMs = DELETE_TIMEOUT_MS } = {}) {
  if (typeof indexedDBArea?.databases !== 'function' || typeof indexedDBArea?.deleteDatabase !== 'function') {
    throw new Error('IDB_UNAVAILABLE')
  }
  const databases = (await indexedDBArea.databases()) || []
  const deleted = []
  const blocked = []
  for (const database of databases) {
    if (typeof database?.name !== 'string' || !database.name) continue
    const result = await deleteDatabase(indexedDBArea, database.name, timeoutMs)
    deleted.push(result.name)
    if (result.blocked) blocked.push(result.name)
  }
  return { deleted, blocked }
}

export async function clearCacheStorage (cachesArea) {
  if (typeof cachesArea?.keys !== 'function' || typeof cachesArea?.delete !== 'function') return
  const names = await cachesArea.keys()
  await Promise.all((names || []).map(name => cachesArea.delete(name)))
}

export async function clearOpfs (storageArea) {
  if (typeof storageArea?.getDirectory !== 'function') return
  const directory = await storageArea.getDirectory()
  if (typeof directory?.entries !== 'function' || typeof directory?.removeEntry !== 'function') return
  for await (const [name] of directory.entries()) {
    await directory.removeEntry(name, { recursive: true })
  }
}

export async function unregisterLauncherServiceWorkers (serviceWorkerArea) {
  if (typeof serviceWorkerArea?.getRegistrations !== 'function') return
  for (const registration of await serviceWorkerArea.getRegistrations()) {
    await registration.unregister()
  }
}

// Returns null when no reset is pending. The caller boots normally after the
// reload; the returned report exists for tests and diagnostics.
export async function applyPendingLocalDevFullReset ({
  localStorageArea = globalThis.localStorage,
  sessionStorageArea = globalThis.sessionStorage,
  indexedDBArea = globalThis.indexedDB,
  cachesArea = globalThis.caches,
  navigatorArea = globalThis.navigator,
  reload = () => globalThis.location?.reload?.(),
  warn = (...args) => console.warn(...args)
} = {}) {
  const pending = readPendingFullReset(localStorageArea)
  if (!pending) return null
  if (pending.attempts >= MAX_FULL_RESET_ATTEMPTS) {
    // Never leave the launcher in a reload loop because one provider refuses
    // to cooperate; the leftovers are visible in DevTools instead.
    clearPendingFullReset(localStorageArea)
    warn(`[local-dev] Abandoning incomplete full reset after ${pending.attempts} attempts`)
    return { abandoned: true, attempts: pending.attempts, failures: [], blocked: [] }
  }
  // Bump before wiping so an interrupted run retries instead of booting
  // half-cleared, and so a crash cannot strand the marker forever.
  writePendingFullReset(localStorageArea, pending.attempts + 1)

  const failures = []
  const report = { abandoned: false, attempts: pending.attempts + 1, failures, blocked: [] }
  const attempt = async (step, work) => {
    try {
      await work()
    } catch (error) {
      failures.push({ step, message: error?.message ?? String(error) })
      warn(`[local-dev] Full reset could not clear ${step}`, error)
    }
  }

  await attempt('indexedDB', async () => {
    const result = await clearLauncherIndexedDb(indexedDBArea)
    report.blocked = result.blocked
    if (result.blocked.length) {
      // Another launcher tab still holds them open; the reload finishes the job.
      warn('[local-dev] Full reset is waiting for other connections to close', result.blocked)
    }
  })
  await attempt('caches', () => clearCacheStorage(cachesArea))
  await attempt('opfs', () => clearOpfs(navigatorArea?.storage))
  await attempt('serviceWorker', () => unregisterLauncherServiceWorkers(navigatorArea?.serviceWorker))
  await attempt('sessionStorage', () => sessionStorageArea?.clear?.())
  // localStorage is last: clearing it removes the marker. A crash before this
  // point leaves the incremented marker for the next boot.
  await attempt('localStorage', () => {
    localStorageArea?.clear?.()
    clearPendingFullReset(localStorageArea)
  })

  reload()
  return report
}
