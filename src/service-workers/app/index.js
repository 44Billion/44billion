// Any change to this file will reinstall sw
import '#config/polyfills.js'
import { injectScript } from '#helpers/html.js'
import { requestMultipleMessages } from '#helpers/window-message/index.js'
import Base93Decoder from '#services/base93-decoder.js'
import appPageScriptContent from '#scripts/app-page.txt.js'
import _appPageLoader from '../../assets/html/app-page-loader.txt.html'
import appPageLoaderScriptContent from '#scripts/app-page-loader.txt.js'
import _trustedAppPage from '../../assets/html/trusted-app-page.txt.html'
import trustedAppPageScriptContent from '#scripts/trusted-app-page.txt.js'
const appPageLoader = injectScript(_appPageLoader, appPageLoaderScriptContent)
const trustedAppPage = injectScript(_trustedAppPage, trustedAppPageScriptContent)

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
  if (e.request.method !== 'GET') return
  let origin
  ;({ pathname: e.request.pathname, origin } = new URL(e.request.url))
  if (origin !== self.location.origin) return

  e.respondWith((async function () {
    if (e.request.pathname === '/~~napp') {
      return new Response(
        trustedAppPage,
        { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } }
      )
    }

    return handleRequest(e.request)
      // TODO: esbuild html text plugin too, then replace {{error}}
      .catch(err => new Response(getErrorHtml(e, err), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' }
      }))
  })())
})

// TODO: add timeout to requestMultipleMessages, catch error and if it's a timeout one
// call selectClientToPostMessagesTo again by recursively retrying handleRequest
async function handleRequest (request) {
  const pathname = request.pathname ?? new URL(request.url).pathname
  const toPort = await selectClientToPostMessagesTo()
  const msg = { code: 'STREAM_APP_FILE', payload: { pathname } }
  const iterator = requestMultipleMessages(toPort, msg, { targetOrigin: self.location.origin || '*' })
  const firstReplyMsg = (await iterator.next()).value

  if (firstReplyMsg.error) {
    switch (firstReplyMsg.error.message) {
      case 'HTML_FILE_NOT_CACHED':
        // this html waits for complete file chunk caching then reloads itself
        return new Response(appPageLoader, { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } })
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
    // appPageScriptContent injects window.(nostr|napp)
    appPage = injectScript(appPage, appPageScriptContent)
    return new Response(appPage, { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } })
  }
}

// Stores clientId to MessagePort map.
// A MessageChannel initiated at the client,
// sending the port to the sw which would
// then use it to do port.postMessage, was
// the way that worked for sw to talk to clients
// because client.postMessage didn't work.
const readyClients = new Map()

// Clean up dead clients periodically, although
// sw tends to be short lived
setInterval(async () => {
  const clients = await self.clients.matchAll()
  const activeIds = new Set(clients.map(c => c.id))
  for (const id of readyClients.keys()) {
    if (!activeIds.has(id)) readyClients.delete(id)
  }
}, 30000)

// A queue to avoid race condition
const resolvers = []

self.addEventListener('message', async e => {
  if (!e.source.id) return
  const { pathname } = new URL(e.source.url)
  switch (e.data.code) {
    // Handle ready signals from clients
    case 'TRUSTED_IFRAME_READY': {
      if (pathname !== '/~~napp') return
      readyClients.set(e.source.id, e.ports[0])
      while (resolvers.length) {
        resolvers.shift()(e.ports[0])
      }
      break
    }
  }
})

let bc
async function selectClientToPostMessagesTo () {
  let targetPort
  while (!targetPort) {
    // Spec already puts most recently focused first
    const clients = await self.clients.matchAll({ includeUncontrolled: false, type: 'window' })
    const targetClient = clients.find(client =>
      new URL(client.url).pathname === '/~~napp' &&
      readyClients.has(client.id) // Check if we have a port for this client
    )

    if (targetClient) targetPort = readyClients.get(targetClient.id)
    else {
      // Not working:
      // clients
      //   .filter(client => new URL(client.url).pathname === '/~~napp')
      //   .forEach(client => {
      //     client.postMessage({ code: 'GET_READY_STATUS' })
      //   })
      // console.log('Service Worker: No client available with ready port, retrying...')
      const { promise, resolve } = Promise.withResolvers()
      resolvers.push(resolve)

      if (resolvers.length === 1) {
        bc ??= new BroadcastChannel('sw~~napp')
        bc.postMessage({ code: 'GET_READY_STATUS', payload: null })
      }

      targetPort = await Promise.race([
        promise,
        new Promise(resolve => setTimeout(resolve, 1000))
      ])

      if (!targetPort) {
        const index = resolvers.indexOf(resolve)
        if (index > -1) {
          resolvers.splice(index, 1)
        }
      }
    }
  }
  return targetPort
}
