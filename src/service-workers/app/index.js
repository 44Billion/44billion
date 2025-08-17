// Any change to this file will reinstall sw
import { injectScript } from '#helpers/html.js'
import { initReplyListener, requestMultipleMessages } from '#helpers/window-message/index.js'
import Base122Decoder from '#services/base122-decoder.js'
import appPageScriptContent from '#scripts/app-page.txt.js'
import _appPageLoader from '../../assets/html/app-page-loader.txt.html'
import appPageLoaderScriptContent from '#scripts/app-page-loader.txt.js'
import _trustedAppPage from '../../assets/html/trusted-app-page.txt.html'
import trustedAppPageScriptContent from '#scripts/trusted-app-page.txt.js'
const appPageLoader = injectScript(_appPageLoader, appPageLoaderScriptContent)
const trustedAppPage = injectScript(_trustedAppPage, trustedAppPageScriptContent)

// this can't be dynamically called at a worker
initReplyListener()

// Stores clientId to MessagePort map.
// A MessageChannel initiated at the client,
// sending the port to the sw which would
// then use it to do port.postMessage, was
// the way that worked for sw to talk to clients
/// because client.postMessaged dind't work.
const readyClients = new Map()

// Clean up dead clients periodically, although
// sw tend to be short lived
setInterval(async () => {
  const clients = await self.clients.matchAll()
  const activeIds = new Set(clients.map(c => c.id))
  for (const id of readyClients.keys()) {
    if (!activeIds.has(id)) readyClients.delete(id)
  }
}, 30000)

// Handle ready signals from clients
self.addEventListener('message', async e => {
  if (
    !e.source.id ||
    e.data.code !== 'TRUSTED_IFRAME_READY' ||
    new URL(e.source.url).pathname !== '/~~napp'
  ) return

  readyClients.set(e.source.id, e.ports[0])
})

const getErrorHtml = (e, err) => /* html */`
<!doctype html>
<html>
  <head>
  </head>
  <body>
    <p>${[e.request.method, e.request.url].join(' | ')}</p>
    <p>Error: ${err.stack ?? err}</p>
  </body>
</html>
`

self.addEventListener('install', async () => {
  console.log('Service Worker: Install event')
  await self.skipWaiting() // Force the new SW to activate immediately
})

self.addEventListener('activate', e => {
  console.log('Service Worker: Activate event')
  e.waitUntil((async function () {
    await self.clients.claim() // Take control of existing clients immediately
    // Regular client.postMessage doesn't work. It's ok as we use BroadcastChannel
    // later, instead of here.
    // const clients = await self.clients.matchAll()
    // clients
    //   .filter(client => new URL(client.url).pathname === '/~~napp')
    //   .forEach(client => {
    //     client.postMessage({ code: 'GET_READY_STATUS' })
    //   })
  })())
})

self.addEventListener('fetch', e => {
  if (!e.clientId) return

  e.request.pathname = new URL(e.request.url).pathname
  e.respondWith((async function () {
    if (e.request.pathname === '/~~napp') {
      return new Response(
        trustedAppPage,
        { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } }
      )
    }

    return handleRequest(e.request)
      // TODO: esbuild html text plugin too, then replace {{error}}
      .catch(err => new Response(getErrorHtml(e, err), { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } }))
  })())
})

// TODO: add timeout to requestMultipleMessages, catch error and if it's a timeout one
// call selectClientToPostMessagesTo again by recursively retrying handleRequest
async function handleRequest (request) {
  const pathname = request.pathname ?? new URL(request.url).pathname
  const toPort = await selectClientToPostMessagesTo() // Now 'toPort' is a MessagePort
  const msg = { code: 'STREAM_APP_FILE', pathname }

  const iterator = requestMultipleMessages(toPort, msg, { targetOrigin: self.location.origin || '*' })
  const firstReplyMsg = (await iterator.next()).value

  if (firstReplyMsg.error) {
    if (firstReplyMsg.error.message !== 'File not cached yet') throw firstReplyMsg.error

    // this html waits for complete file chunk caching then reloads itself
    return new Response(appPageLoader, { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } })
  }
  const { content: firstContent, contentType } = firstReplyMsg.payload
  async function * source () {
    yield firstContent
    for await (const { payload: { content }, error } of iterator) {
      if (error) throw error
      yield content
    }
  }

  if (contentType !== 'text/html') {
    return new Response(
      new Base122Decoder(source).getDecoded(),
      { headers: { 'content-type': contentType, 'cache-control': 'no-cache' } }
    )
  } else {
    let appPage = ''
    let htmlChunk
    for await (htmlChunk of new Base122Decoder(source).getDecoded()) {
      appPage += htmlChunk
    }
    // appPageScriptContent injects window.(nostr|napp)
    appPage = injectScript(appPage, appPageScriptContent)
    return new Response(appPage, { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } })
  }
}

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
      console.log('Service Worker: No client available with ready port, retrying...')
      bc ??= new BroadcastChannel('sw~~napp')
      bc.postMessage({ code: 'GET_READY_STATUS', payload: null })
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }
  return targetPort
}
