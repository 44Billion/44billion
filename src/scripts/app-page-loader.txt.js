import { postMessage, requestMultipleMessages } from '#helpers/window-message/index.js'
import Base93Decoder from '#services/base93-decoder.js'

// ERROR: Top-level await is currently not supported with the "iife" output format [plugin js-text]
// https://github.com/evanw/esbuild/issues/253
(async () => {
  const napp = new class extends EventTarget {
    icon = null
    progress = null
  }()
  window.napp = napp

  const browserPort = await tellParentImReady()
  maybeSetIcon(napp, browserPort)
  updateRouteLoadProgress(napp, browserPort)
})()

function tellParentImReady () {
  const readyMsg = {
    code: 'APP_IFRAME_READY',
    payload: null
  }
  const { port1: browserPort, port2: appPagePortForBrowser } = new MessageChannel()
  const p = Promise.withResolvers()
  browserPort.addEventListener('message', e => {
    if (e.data.code !== 'BROWSER_READY') return p.reject()
    p.resolve(browserPort)
  }, { once: true })
  browserPort.start()
  postMessage(window.parent, readyMsg, { targetOrigin: '*', transfer: [appPagePortForBrowser] })
  return p.promise
}

async function maybeSetIcon (napp, to) {
  const iconMsg = { code: 'STREAM_APP_ICON', payload: { pathname: window.location.pathname } }
  const iterator = requestMultipleMessages(to, iconMsg)
  function extractFirstDataFromChunkMsg ({ payload, error }) {
    if (error) return {}
    return {
      mimeType: payload.mimeType || 'image/vnd.microsoft.icon',
      contentType: payload.contentType || 'image/vnd.microsoft.icon',
      content: payload.content
    }
  }
  const { mimeType, contentType, content: firstContent } = extractFirstDataFromChunkMsg((await iterator.next()).value)
  if (!firstContent) { console.log('no icon'); return }

  async function * source () {
    yield firstContent
    for await (const { payload, error } of iterator) {
      if (error) throw error
      yield payload.content
    }
  }

  const decodedStream = new Base93Decoder(source(), { mimeType }).getDecoded()
  const response = new Response(decodedStream, { headers: { 'content-type': contentType } })
  napp.icon = URL.createObjectURL(await response.blob())
  napp.dispatchEvent(new CustomEvent('iconready'))
}

async function updateRouteLoadProgress (napp, to) {
  const routeLoadMsg = { code: 'CACHE_APP_FILE', payload: { pathname: window.location.pathname } }

  for await (const { payload: progress, error } of requestMultipleMessages(to, routeLoadMsg)) {
    if (error) { console.log(error); continue }
    napp.progress = progress
    napp.dispatchEvent(new CustomEvent('progress'))
  }
}
