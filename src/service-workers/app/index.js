// Any change to this file will reinstall sw
import '#config/polyfills.js'
import { injectIntoTheHeadTag } from '#helpers/html.js'
import { askStream, tell } from '#helpers/window-message/index.js'
import { Base93Decoder } from 'libp2r2p/base93'
import appPageScriptContent from '#scripts/app-page.txt.js'
import _appPageLoader from '../../assets/html/app-page-loader.txt.html'
import appPageLoaderScriptContent from '#scripts/app-page-loader.txt.js'
import _trustedAppPage from '../../assets/html/trusted-app-page.txt.html'
import trustedAppPageScriptContent from '#scripts/trusted-app-page.txt.js'
import { cssStrings } from '#assets/styles/theme.js'
import {
  findReadyBridgeClient,
  pruneReadyClients
} from '#helpers/service-worker-bridge-router.js'
import { isRetryableAppBridgeError } from '#helpers/window-message/app-bridge-error.js'
import { attachmentHeaders, parseNfileUrl } from '#helpers/nfile-download-url.js'
const appPageLoader = injectIntoTheHeadTag(
  _appPageLoader.replace('/* APP_PAGE_LOADER_THEME */', cssStrings.appPageLoaderTheme),
  `<script>${appPageLoaderScriptContent}</script>`
)
const trustedAppPage = injectIntoTheHeadTag(_trustedAppPage, `<script>${trustedAppPageScriptContent}</script>`)

// Napp HTML is third-party code and may reference cleartext URLs. A blocked
// mixed-content request marks the whole tab "not secure", which makes Chrome
// refuse WebAuthn inside the vault iframe. Upgrading insecure requests before
// the browser's mixed-content check (http -> https, ws -> wss) keeps the tab
// secure. Development on *.localhost has no mixed content to fix.
const upgradeInsecureRequestsHeaders = IS_PRODUCTION
  ? { 'content-security-policy': 'upgrade-insecure-requests' }
  : {}
const htmlHeaders = headers => ({ ...headers, ...upgradeInsecureRequestsHeaders })

const getErrorHtml = (e, err) => /* html */`
<!doctype html>
<html>
  <head>
  </head>
  <body>
    <p>${[e.request.method, e.request.url].join(' | ')}</p>
    <p>[Error] ${err?.stack ?? err ?? 'Unknown Error'}</p>
  </body>
</html>
`

self.addEventListener('install', () => {
  console.log('[Service Worker] Install event')
})

self.addEventListener('activate', () => {
  console.log('[Service Worker] Activate event')
})

self.addEventListener('fetch', e => {
  const mapUrl = new URL(e.request.url)
  if (mapUrl.origin === self.location.origin && mapUrl.pathname.startsWith('/~~sourcemaps/')) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }))
    return
  }

  // Don't add `if (!e.clientId) return` guard clause
  // or else for '/~~napp' initial page load the sw may call the server
  // instead of handling the request by itself
  // Also, Firefox (wrongly) uses e.clientId='' instead of null/undefined
  // for regular window clients (on development atleast; localhost and/or http)
  //
  // Alternatives depending on use-case:
  // Check if it's a navigation request (initial page load)
  // if (event.request.mode === 'navigate') {
  //   // Handle navigation requests differently
  //   return
  // }
  // // Or check request destination
  // if (event.request.destination === 'document') {
  //   // This is likely a page navigation
  //   return
  // }
  // // Normal fetch handling

  // console.log('Service Worker: fetching', e.request.url)
  const requestUrl = new URL(e.request.url)
  const markerBridgeId = requestUrl.searchParams.get('~~bridgeId')
  if (markerBridgeId && e.clientId && !requestUrl.pathname.startsWith('/~~nfile/')) {
    // Remember the bridge id before serving the first document: subsequent
    // requests from this app page (after the injected script strips the
    // marker) keep routing to the trusted iframe of the same tab.
    appPageBridgeIds.set(e.clientId, markerBridgeId)
  }
  if (requestUrl.origin === self.location.origin && requestUrl.pathname.startsWith('/~~nfile/')) {
    e.respondWith((async () => {
      try {
        if (!['GET', 'HEAD'].includes(e.request.method)) return new Response(null, { status: 405 })
        if ([...requestUrl.searchParams].some(([key, value]) => key !== '~~bridgeId' && (key !== 'localOnly' || value !== '1')) || requestUrl.searchParams.getAll('~~bridgeId').length !== 1 || requestUrl.searchParams.getAll('localOnly').length > 1) throw new Error('INVALID_NFILE_URL')
        const url = new URL(`https://nostr.alt/${requestUrl.pathname.slice('/~~nfile/'.length)}`)
        if (requestUrl.searchParams.get('localOnly') === '1') url.searchParams.set('localOnly', '1')
        parseNfileUrl(url.href)
        const knownBridge = appPageBridgeIds.get(e.clientId)
        if (!markerBridgeId || (knownBridge && knownBridge !== markerBridgeId)) throw new Error('APP_BRIDGE_UNAVAILABLE')
        const response = await handleNfileRequest(e.request, url, { clientId: e.clientId, bridgeId: markerBridgeId })
        return new Response(response.body, { status: response.status, headers: attachmentHeaders(response.headers) })
      } catch {
        return new Response(null, { status: 404, headers: attachmentHeaders({ 'content-length': '0' }) })
      }
    })())
    return
  }
  const isNfile = requestUrl.origin === 'https://nostr.alt' &&
    /^\/nfile1[0-9a-z]+$/.test(requestUrl.pathname)
  if (isNfile) {
    if (!['GET', 'HEAD'].includes(e.request.method) || e.request.mode === 'navigate') return
    e.respondWith(handleNfileRequest(e.request, requestUrl, { clientId: e.clientId }))
    return
  }

  if (e.request.method !== 'GET') return
  let origin
  ;({ pathname: e.request.pathname, origin } = requestUrl)
  if (origin !== self.location.origin) return

  // Top-level browser navigation to numeric subdomain - redirect to main domain
  // Uses client-side redirect (not 302) so location.hash is preserved
  if (e.request.destination === 'document') {
    const subdomain = self.location.host.split('.')[0]
    const mainHost = self.location.host.replace(/^\d+\./, '')
    const url = new URL(e.request.url)
    const basePath = url.pathname + url.search
    e.respondWith(new Response(
      `<!doctype html><script>location.replace("${self.location.protocol}//${mainHost}/?subdomain=${subdomain}&path="+encodeURIComponent(${JSON.stringify(basePath)}+location.hash))</script>`,
      { headers: htmlHeaders({ 'content-type': 'text/html', 'cache-control': 'no-cache' }) }
    ))
    return
  }

  e.respondWith((async function () {
    if (e.request.pathname === '/~~napp') {
      return new Response(
        trustedAppPage,
        { headers: htmlHeaders({ 'content-type': 'text/html', 'cache-control': 'no-cache' }) }
      )
    }

    return handleRequest(e.request)
      // TODO: esbuild html text plugin too, then replace {{error}}
      .catch(err => new Response(getErrorHtml(e, err), {
        status: 404,
        statusText: 'Not Found',
        headers: htmlHeaders({ 'content-type': 'text/html', 'cache-control': 'no-cache' })
      }))
  })())
})

const MAX_SW_ROUTE_ATTEMPTS = 3
const SW_FIRST_REPLY_TIMEOUT_MS = 8000
const SW_STREAM_IDLE_TIMEOUT_MS = 60000
const APP_BRIDGE_UNAVAILABLE = 'APP_BRIDGE_UNAVAILABLE'

function retryableBridgeError (error) {
  return Object.assign(new Error('App bridge retry'), {
    code: 'APP_BRIDGE_RETRY',
    cause: error
  })
}

async function runWithBridgeRetry (task) {
  let lastError
  for (let attempt = 0; attempt < MAX_SW_ROUTE_ATTEMPTS; attempt++) {
    try {
      return await task(attempt)
    } catch (error) {
      if (!isRetryableAppBridgeError(error)) throw error
      lastError = error
      console.warn(
        `[app-sw] Bridge attempt ${attempt + 1}/${MAX_SW_ROUTE_ATTEMPTS} failed; retrying`,
        {
          pathname: error?.pathname,
          code: error?.code,
          kind: error?.kind,
          message: error?.message
        }
      )
    }
  }
  console.error('[app-sw] Bridge retries exhausted', lastError)
  throw lastError
}

async function tryHandleNfileRequest (request, url, routing = {}) {
  const selected = await selectClientToPostMessagesTo(routing)
  const toPort = selected.port
  const requestToken = globalThis.crypto?.randomUUID?.() || `${Date.now()}:${Math.random()}`
  let cancelSent = false
  const cancel = () => {
    if (cancelSent) return
    cancelSent = true
    tell(toPort, {
      code: 'CANCEL_NFILE',
      payload: { requestToken }
    }, {})
  }
  request.signal?.addEventListener('abort', cancel, { once: true })
  const iterator = askStream(toPort, {
    code: 'STREAM_NFILE',
    payload: {
      entity: url.pathname.slice(1),
      method: request.method,
      range: request.headers.get('range'),
      localOnly: url.searchParams.get('localOnly') === '1',
      requestToken,
      requestClientId: routing.clientId,
      flowControlled: true
    }
  }, {
    targetOrigin: self.location.origin || '*',
    timeoutMs: SW_FIRST_REPLY_TIMEOUT_MS,
    idleTimeoutMs: SW_STREAM_IDLE_TIMEOUT_MS
  })

  const first = await iterator.next()
  if (first.done || first.value?.error) {
    cancel()
    request.signal?.removeEventListener('abort', cancel)
    if (first.value?.error?.code === 'STREAM_TIMEOUT') {
      await iterator.return?.()
      readyClients.delete(selected.clientId)
      const retryError = retryableBridgeError(first.value.error)
      retryError.pathname = url.pathname
      throw retryError
    }
    throw first.value?.error || new Error('Nfile request ended without a response')
  }
  const { status, headers } = first.value.payload
  if (request.method === 'HEAD' || status === 404 || status === 416) {
    await iterator.return?.()
    cancel()
    request.signal?.removeEventListener('abort', cancel)
    return new Response(null, { status, headers })
  }

  let finished = false
  const finish = async () => {
    if (finished) return
    finished = true
    await iterator.return?.()
    cancel()
    request.signal?.removeEventListener('abort', cancel)
  }
  const body = new ReadableStream({
    async pull (controller) {
      tell(toPort, { code: 'PULL_NFILE', payload: { requestToken } }, {})
      try {
        while (true) {
          const next = await iterator.next()
          if (next.done || next.value?.payload?.done) {
            controller.close()
            await finish()
            return
          }
          if (next.value?.error) throw next.value.error
          const chunk = next.value?.payload?.chunk
          if (chunk instanceof Uint8Array) {
            controller.enqueue(chunk)
            return
          }
        }
      } catch (error) {
        controller.error(error)
        await finish()
      }
    },
    cancel () {
      return finish()
    }
  })
  return new Response(body, { status, headers })
}

async function handleNfileRequest (request, url, routing) {
  return runWithBridgeRetry(() => tryHandleNfileRequest(request, url, routing))
}

async function tryHandleRequest (request) {
  const pathname = request.pathname ?? new URL(request.url).pathname
  const selected = await selectClientToPostMessagesTo({ clientId: request.clientId })
  const msg = {
    code: 'STREAM_APP_FILE',
    payload: {
      pathname,
      requestClientId: request.clientId
    }
  }
  const iterator = askStream(selected.port, msg, {
    targetOrigin: self.location.origin || '*',
    timeoutMs: SW_FIRST_REPLY_TIMEOUT_MS,
    idleTimeoutMs: SW_STREAM_IDLE_TIMEOUT_MS
  })
  const firstReplyMsg = (await iterator.next()).value

  if (firstReplyMsg === undefined || firstReplyMsg.error?.code === 'STREAM_TIMEOUT') {
    await iterator.return?.()
    readyClients.delete(selected.clientId)
    const retryError = retryableBridgeError(firstReplyMsg?.error || new Error('App bridge timed out'))
    retryError.pathname = pathname
    throw retryError
  }

  if (firstReplyMsg.error) {
    switch (firstReplyMsg.error.message) {
      case 'HTML_FILE_NOT_CACHED':
        // this html waits for complete file chunk caching then reloads itself
        return new Response(appPageLoader, { headers: htmlHeaders({ 'content-type': 'text/html', 'cache-control': 'no-cache' }) })
      case 'FILE_NOT_CACHED':
        console.log(`[Service Worker] Asset not found for path: ${pathname}:\n${firstReplyMsg.error?.stack ?? firstReplyMsg.error ?? 'Unknown Error'}`)
        return new Response(null, {
          status: 404,
          statusText: 'Not Found',
          headers: { 'cache-control': 'no-cache' }
        })
      default: throw firstReplyMsg.error
    }
  }
  const { content: firstContent, contentType } = firstReplyMsg.payload
  async function * source () {
    yield firstContent
    for await (const { payload: { content }, error } of iterator) {
      if (error) throw error
      yield content
    }
  }

  if (!contentType.startsWith('text/html')) {
    return new Response(
      new Base93Decoder(source, { mimeType: contentType }).getDecoded(),
      { headers: { 'content-type': contentType, 'cache-control': 'no-cache' } }
    )
  } else {
    let appPage = ''
    let htmlChunk
    for await (htmlChunk of new Base93Decoder(source, { mimeType: contentType, preferTextStreamDecoding: true }).getDecoded()) {
      appPage += htmlChunk
    }
    const colorSchemeTag = '<meta name="color-scheme" content="light dark">'
    appPage = injectIntoTheHeadTag(
      appPage,
      `${
        colorSchemeTag // enable transparent bg, specially for when loading additional assets
      }<script>${
        appPageScriptContent // inject window.(nostr|napp)
      }</script>`
    )
    return new Response(appPage, { headers: htmlHeaders({ 'content-type': 'text/html', 'cache-control': 'no-cache' }) })
  }
}

async function handleRequest (request) {
  return runWithBridgeRetry(() => tryHandleRequest(request))
}

// Stores clientId to MessagePort map.
// A MessageChannel initiated at the client,
// sending the port to the sw which would
// then use it to do port.postMessage, was
// the way that worked for sw to talk to clients
// because client.postMessage didn't work.
const readyClients = new Map() // clientId -> { port, readyAt, bridgeId }
const appPageBridgeIds = new Map() // appPageClientId -> bridgeId

// Clean up dead clients periodically, although
// sw tends to be short lived
setInterval(async () => {
  const clients = await self.clients.matchAll()
  const activeIds = new Set(clients.map(c => c.id))
  for (const id of readyClients.keys()) {
    if (!activeIds.has(id)) readyClients.delete(id)
  }
  for (const id of appPageBridgeIds.keys()) {
    if (!activeIds.has(id)) appPageBridgeIds.delete(id)
  }
}, 30000)

// A queue to avoid race condition
const resolvers = []

self.addEventListener('message', async e => {
  if (!e.source?.id) return
  const { pathname } = new URL(e.source.url)
  switch (e.data?.code) {
    case 'CHECK_ORIGIN_IDLE': {
      const port = e.ports?.[0]
      if (!port) return
      // Include uncontrolled documents/workers from older launcher versions.
      // Only the cleanup iframe may remain during recycling; local resets can
      // also retain trusted bridges, which do not execute application code.
      e.waitUntil((async () => {
        try {
          const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'all' })
          const idle = clients.every(client => {
            if (client.id === e.source.id) return true
            if (IS_DEVELOPMENT && e.data.allowTrustedBridges && client.type === 'window') {
              const url = new URL(client.url)
              return url.pathname === '/~~napp' && url.searchParams.has('bridgeId')
            }
            return false
          })
          port.postMessage({ code: 'ORIGIN_IDLE', idle })
        } catch {
          port.postMessage({ code: 'ORIGIN_IDLE', idle: false })
        } finally {
          port.close()
        }
      })())
      break
    }
    // Handle ready signals from clients
    case 'TRUSTED_IFRAME_READY': {
      if (pathname !== '/~~napp') return
      const bridgeId = e.data.payload?.bridgeId || ''
      readyClients.set(e.source.id, { port: e.ports[0], readyAt: Date.now(), bridgeId })
      for (let index = resolvers.length - 1; index >= 0; index--) {
        const resolver = resolvers[index]
        if (resolver.bridgeId && resolver.bridgeId !== bridgeId) continue
        resolvers.splice(index, 1)
        if (resolver.timer) clearTimeout(resolver.timer)
        resolver.resolve({ port: e.ports[0], clientId: e.source.id })
      }
      break
    }
    case 'APP_PAGE_BRIDGE': {
      const bridgeId = e.data.payload?.bridgeId
      if (bridgeId) appPageBridgeIds.set(e.source.id, bridgeId)
      break
    }
  }
})

let bc
function requestBridgeReady (bridgeId = '') {
  const pending = resolvers.find(resolver => resolver.bridgeId === bridgeId)
  if (pending) return pending.promise
  const { promise, resolve, reject } = Promise.withResolvers()
  const resolver = { resolve, reject, promise, timer: null, bridgeId }
  resolvers.push(resolver)
  // Address the retained trusted document directly after worker restarts.
  self.clients.matchAll({ includeUncontrolled: false, type: 'window' }).then(clients => {
    for (const client of clients) {
      const url = new URL(client.url)
      if (url.pathname === '/~~napp' && (!bridgeId || url.searchParams.get('bridgeId') === bridgeId)) client.postMessage({ code: 'GET_READY_STATUS' })
    }
  }).catch(() => {})
  // Older retained documents only listen on BroadcastChannel. Avoid replacing
  // the newly established port twice when the direct request already worked.
  const fallback = setTimeout(() => {
    if (!resolvers.includes(resolver)) return
    bc ??= new BroadcastChannel('sw~~napp')
    bc.postMessage({ code: 'GET_READY_STATUS', payload: null })
  }, 500)
  resolver.timer = setTimeout(() => {
    const index = resolvers.indexOf(resolver)
    if (index > -1) resolvers.splice(index, 1)
    reject(Object.assign(new Error('App bridge not ready'), { code: APP_BRIDGE_UNAVAILABLE }))
  }, SW_FIRST_REPLY_TIMEOUT_MS)
  promise.finally(() => clearTimeout(fallback)).catch(() => {})
  return promise
}

function hasTrustedClientForBridge (clients, bridgeId) {
  return clients.some(client => {
    try {
      const url = new URL(client.url)
      return url.pathname === '/~~napp' && url.searchParams.get('bridgeId') === bridgeId
    } catch {
      return false
    }
  })
}

async function recoverAppPageBridge (clientId) {
  const client = await self.clients.get(clientId)
  if (!client) throw new Error(APP_BRIDGE_UNAVAILABLE)
  const bridgeId = await new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel()
    const timer = setTimeout(() => { port1.close(); reject(new Error(APP_BRIDGE_UNAVAILABLE)) }, SW_FIRST_REPLY_TIMEOUT_MS)
    port1.onmessage = event => {
      clearTimeout(timer); port1.close()
      resolve(event.data?.bridgeId)
    }
    client.postMessage({ code: 'GET_APP_PAGE_BRIDGE' }, [port2])
  })
  if (!bridgeId) throw new Error(APP_BRIDGE_UNAVAILABLE)
  appPageBridgeIds.set(clientId, bridgeId)
  return bridgeId
}

async function selectClientToPostMessagesTo ({ clientId = '', bridgeId = appPageBridgeIds.get(clientId) || '' } = {}) {
  if (clientId && !bridgeId) bridgeId = await recoverAppPageBridge(clientId)
  const strict = Boolean(bridgeId)
  let lastError
  for (let attempt = 0; attempt < MAX_SW_ROUTE_ATTEMPTS; attempt++) {
    const clients = await self.clients.matchAll({ includeUncontrolled: false, type: 'window' })
    pruneReadyClients(clients, readyClients)
    const targetClient = findReadyBridgeClient(clients, readyClients, bridgeId, { strict })

    // A live trusted iframe may not have a readyClients entry yet (e.g. the
    // service worker restarted while the iframe stayed loaded). In that case
    // fall through to requestBridgeReady(), which asks it to re-register via
    // the sw~~napp BroadcastChannel instead of crashing on a missing port.
    // Also require a real port: a stale registration without one must not be
    // returned (reading `.port` of a missing entry was the source of the
    // `Cannot read properties of undefined (reading 'port')` crashes).
    const entry = targetClient ? readyClients.get(targetClient.id) : null
    if (entry?.port) {
      return {
        port: entry.port,
        clientId: targetClient.id
      }
    }

    // With a known bridge id, only that tab's trusted iframe may serve this
    // app. If it does not exist at all, fail fast instead of waiting out the
    // retry window on a stale or missing bridge.
    if (strict && !hasTrustedClientForBridge(clients, bridgeId)) {
      throw Object.assign(new Error('App bridge unavailable: trusted iframe not found'), {
        code: APP_BRIDGE_UNAVAILABLE
      })
    }

    try {
      return await requestBridgeReady(bridgeId)
    } catch (error) {
      lastError = error
    }
  }
  throw Object.assign(new Error('App bridge unavailable after retries'), {
    code: APP_BRIDGE_UNAVAILABLE,
    cause: lastError
  })
}
