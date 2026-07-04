import { base62ToBase16 } from '#helpers/base62.js'

function defaultGetNostrDb (ownerPubkey) {
  return {
    async deleteEventsByApp (appId) {
      const { getNostrDb } = await import('#services/idb/nostrdb/index.js')
      return getNostrDb(ownerPubkey).deleteEventsByApp(appId)
    }
  }
}

export function askAppToClearData (appSubdomain, {
  _document = document,
  _window = window,
  _setTimeout = setTimeout,
  _clearTimeout = clearTimeout,
  timeoutMs = 5000
} = {}) {
  if (appSubdomain == null) return Promise.resolve(false)
  const p = Promise.withResolvers()
  const iframe = _document.createElement('iframe')
  iframe.style.display = 'none'

  let timeout = null
  const cleanup = () => {
    if (timeout) _clearTimeout(timeout)
    _window.removeEventListener('message', onMessage)
    iframe.remove?.()
  }

  const appOrigin = `${_window.location.protocol}//${appSubdomain}.${_window.location.host}`
  const onMessage = e => {
    if (e.origin !== appOrigin) return
    if (e.data.code === 'DATA_CLEARED') {
      cleanup()
      p.resolve(true)
    }
    if (e.data.code === 'DATA_CLEAR_ERROR') {
      cleanup()
      p.reject(e.data.error)
    }
  }
  _window.addEventListener('message', onMessage)
  iframe.src = `${appOrigin}/~~napp#clear`
  _document.body.appendChild(iframe)

  timeout = _setTimeout(() => {
    cleanup()
    p.reject(new Error('Data clear timeout'))
  }, timeoutMs)
  return p.promise
}

export async function resetDraftAppRuntimeData ({
  appId,
  userPk,
  appSubdomain,
  _askAppToClearData = askAppToClearData,
  _getNostrDb = defaultGetNostrDb,
  _base62ToBase16 = base62ToBase16,
  _console = console
} = {}) {
  if (!appId) return false

  try {
    await _askAppToClearData(appSubdomain)
  } catch (err) {
    _console.warn('Failed to clear draft app origin data before reload', err)
  }

  try {
    const ownerPubkey = _base62ToBase16(userPk).toLowerCase()
    await _getNostrDb(ownerPubkey).deleteEventsByApp(appId)
  } catch (err) {
    _console.warn('Failed to clear draft app NostrDB rows before reload', err)
  }

  return true
}
