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

const getErrorHtml = (e, err) => /* html */`
<!doctype html>
<html>
  <head>
  </head>
  <body>
    <p>${[e.request.method, e.request.url].join(' | ')}</p>
    <p>Error: ${err.stack}</p>
  </body>
</html>
`
self.addEventListener('install', () => {
  console.log('Service Worker: Install event')
  self.skipWaiting() // Force the new SW to activate immediately
})

self.addEventListener('activate', (event) => {
  console.log('Service Worker: Activate event')
  event.waitUntil(self.clients.claim()) // Take control of existing clients immediately
})

self.addEventListener('fetch', e => {
  if (
    !e.clientId ||
    (e.request.pathname = new URL(e.request.url).pathname) !== '/~~napp'
  ) return
  e.respondWith(new Response(trustedAppPage, { headers: { 'content-type': 'text/html' } }))
})

self.addEventListener('fetch', e => {
  if (!e.clientId) return
  e.respondWith(
    handleRequest(e.request)
      // future: esbuild html text plugin too, then replace {{error}}
      .catch(err => new Response(getErrorHtml(e, err), { headers: { 'content-type': 'text/html' } }))
  )
})

async function handleRequest (request) {
  const pathname = request.pathname ?? new URL(request.url).pathname
  const to = await selectClientToPostMessagesTo()
  const msg = { code: 'STREAM_APP_FILE', pathname }
  console.log('GET FILE', request.url, '<- which one; to ->', new URL(to.url).origin, 'type:', typeof self.location.origin) // self.location.origin  is empty
  const iterator = requestMultipleMessages(to, msg, { targetOrigin: new URL(to.url).origin }) // '*' /* self.location.origin */ })
  console.log('GETTING FILE', request.url, 'from', to)
  const firstReplyMsg = (await iterator.next()).value
  console.log('GOT FIRST CHUNK FILE', request.url, firstReplyMsg)

  if (firstReplyMsg.error) {
    if (firstReplyMsg.error.message !== 'File not cached yet') throw firstReplyMsg.error

    // this html waits for complete file chunk caching then reloads itself
    return new Response(appPageLoader, { headers: { 'content-type': 'text/html' } })
  }
  const { content: firstContent, contentType } = firstReplyMsg.payload
  console.log('firstContent', firstContent)
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
      { headers: { 'content-type': contentType } }
    )
  } else {
    let appPage = ''
    let htmlChunk
    for await (htmlChunk of new Base122Decoder(source).getDecoded()) {
      appPage += htmlChunk
    }
    // appPageScriptContent injects window.(nostr|napp)
    appPage = injectScript(appPage, appPageScriptContent)
    return new Response(appPage, { headers: { 'content-type': 'text/html' } })
  }
}

async function selectClientToPostMessagesTo () {
  let targetClient
  while (!targetClient) {
    // Spec already puts most recently focused first
    const clients = await self.clients.matchAll({ includeUncontrolled: false, type: 'window' })
    targetClient = clients.find(client => new URL(client.url).pathname === '/~~napp')
    if (!targetClient) {
      console.log('Service Worker: No client available, retrying...')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  return targetClient
}
