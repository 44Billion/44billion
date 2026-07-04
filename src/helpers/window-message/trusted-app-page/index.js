// We use an always-on trusted app page to add a 'message' listener to
// instead of injecting it to all (loaded) regular app pages
// this page is an iframe at a trusted html generated and served by the sw,
// loaded at <appid>.44billion.net/~~napp
// being the first hop of sw-to-browser communication
//
// Note: wildcard certificates for second-level subdomains are hard to get (*.<many>.a.com),
// that's why we can't do  <loggedinuserpubkey>.<appid>.44billion.net
import { tell } from '../index.js'

function normalizeError (error) {
  if (error instanceof Error) return error
  return new Error(String(error ?? 'Unknown error'))
}

async function clearIndexedDb (indexedDB) {
  if (typeof indexedDB?.databases !== 'function' || typeof indexedDB?.deleteDatabase !== 'function') return
  const databases = await indexedDB.databases()
  await Promise.all((databases || [])
    .filter(db => typeof db?.name === 'string' && db.name)
    .map(db =>
      new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(db.name)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })
    ))
}

async function clearCacheStorage (caches) {
  if (typeof caches?.keys !== 'function' || typeof caches?.delete !== 'function') return
  const cacheNames = await caches.keys()
  await Promise.all((cacheNames || []).map(name => caches.delete(name)))
}

function clearCookies (document) {
  if (!document || typeof document.cookie !== 'string') return
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0]?.trim()
    if (!name) continue
    document.cookie = `${encodeURIComponent(decodeURIComponent(name))}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0; path=/`
  }
}

async function clearOpfsDirectory (directory) {
  if (typeof directory?.entries !== 'function' || typeof directory?.removeEntry !== 'function') return
  for await (const [name] of directory.entries()) {
    await directory.removeEntry(name, { recursive: true })
  }
}

async function clearOpfs (storage) {
  if (typeof storage?.getDirectory !== 'function') return
  await clearOpfsDirectory(await storage.getDirectory())
}

async function unregisterServiceWorker (serviceWorker) {
  if (typeof serviceWorker?.getRegistration !== 'function') return
  const registration = await serviceWorker.getRegistration()
  if (registration) await registration.unregister()
}

async function runClearStep (failures, step, fn) {
  try {
    await fn()
  } catch (error) {
    failures.push({ step, error: normalizeError(error) })
  }
}

function clearErrorFromFailures (failures) {
  const error = new AggregateError(
    failures.map(failure => failure.error),
    'Failed to clear all app data'
  )
  error.failures = failures.map(({ step, error }) => ({
    step,
    name: error.name,
    message: error.message
  }))
  return error
}

export async function clearAppData ({
  _window = window,
  _navigator = navigator,
  _document = document,
  _caches = globalThis.caches,
  _tell = tell
} = {}) {
  const failures = []

  await runClearStep(failures, 'indexedDB', () => clearIndexedDb(_window.indexedDB))
  await runClearStep(failures, 'localStorage', () => _window.localStorage?.clear?.())
  await runClearStep(failures, 'sessionStorage', () => _window.sessionStorage?.clear?.())
  await runClearStep(failures, 'caches', () => clearCacheStorage(_caches))
  await runClearStep(failures, 'cookies', () => clearCookies(_document))
  await runClearStep(failures, 'opfs', () => clearOpfs(_navigator.storage))
  await runClearStep(failures, 'serviceWorker', () => unregisterServiceWorker(_navigator.serviceWorker))

  if (failures.length === 0) {
    _tell(_window.parent, { code: 'DATA_CLEARED', payload: null }, { targetOrigin: '*' })
  } else {
    const error = clearErrorFromFailures(failures)
    _tell(_window.parent, {
      code: 'DATA_CLEAR_ERROR',
      payload: { failures: error.failures },
      error
    }, { targetOrigin: '*' })
  }
}

const swOrigin = window.location.origin // same as app's origin
let browserPortPromise
let swPortPromise
let swPort
let trustedAppPagePortForSw

export function initMessageListener () {
  // Only way that worked for the sw to talk to this page
  // when it didn't have a MessageChannel port sent
  // from this page already
  const bc = new BroadcastChannel('sw~~napp')
  bc.addEventListener('message', async e => {
    if (e.data.code !== 'GET_READY_STATUS') return
    tellSwImReady()
  })
}

let ac
export function tellSwImReady () {
  // sw checks this to tell if the iframe is ready
  const readyMsg = {
    code: 'TRUSTED_IFRAME_READY',
    payload: null
  }
  // always create a new one because port2 will be
  // lost when sw gets killed
  ;({ port1: swPort, port2: trustedAppPagePortForSw } = new MessageChannel())
  let resolve
  ;({ promise: swPortPromise, resolve } = Promise.withResolvers())
  resolve(swPort)

  ac?.abort()
  ac = new AbortController()
  // This port1 will receive messages from the service worker
  swPort.addEventListener('message', async e => {
    tell(await browserPortPromise, e.data)
  }, { signal: ac.signal })
  swPort.start()

  tell(getSw(), readyMsg, { targetOrigin: swOrigin, transfer: [trustedAppPagePortForSw] })
}

export function tellParentImReady () {
  // sw needs this iframe ready to bridge communication to app browser
  // to load real app page files, so parent will
  // wait for this to add real app page iframe to DOM
  const readyMsg = {
    code: 'TRUSTED_IFRAME_READY',
    payload: null
  }

  const { port1: browserPort, port2: trustedAppPagePortForBrowser } = new MessageChannel()
  let resolve, reject
  ;({ promise: browserPortPromise, resolve, reject } = Promise.withResolvers())
  browserPort.addEventListener('message', e => {
    if (e.data.code !== 'BROWSER_READY') return reject()
    resolve(browserPort)
  }, { once: true })
  browserPort.addEventListener('message', async e => {
    switch (e.data.code) {
      case 'REPLY': {
        // forward down
        //
        // Sending to sw with regular (no port) postMessage works
        // but the inverse doesn't for some reason (browser bug?)
        // and needs a MessageChannel (that can't be created on sw)
        // Since we have a channel port, we'll use it
        tell(await swPortPromise, e.data, { targetOrigin: swOrigin })
        break
      }
    }
  })
  browserPort.start()
  tell(window.parent, readyMsg, { targetOrigin: '*', transfer: [trustedAppPagePortForBrowser] })
}

function getSw () {
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller
  throw new Error('Should wait')
}
