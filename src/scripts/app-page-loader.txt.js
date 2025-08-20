import { postMessage, requestMultipleMessages } from '#helpers/window-message/index.js'
import Base122Decoder from '#services/base122-decoder.js'

const napp = new class extends EventTarget {
  icon = null
  progress = null
}()
window.napp = napp

const browserPort = tellParentImReady()
maybeSetIcon(browserPort)
updateRouteLoadProgress(browserPort)

function tellParentImReady () {
  const readyMsg = {
    code: 'APP_IFRAME_READY',
    payload: null
  }
  const { port1: browserPort, port2: appPagePortForBrowser } = new MessageChannel()
  postMessage(window.parent, readyMsg, { targetOrigin: '*', transfer: [appPagePortForBrowser] })
  return browserPort
}

async function maybeSetIcon (to) {
  const iconMsg = { code: 'STREAM_APP_ICON', payload: { pathname: window.location.pathname } }
  const iterator = requestMultipleMessages(to, iconMsg)
  function extractFirstDataFromChunkMsg ({ payload: evt, error }) {
    if (error) return {}
    return {
      mimeType: evt.tags.find(t => t[0] === 'm' && t[1])?.[1] || 'image/vnd.microsoft.icon',
      content: evt.content
    }
  }
  const { mimeType, content: firstContent } = extractFirstDataFromChunkMsg((await iterator.next()).value)
  if (!firstContent) { console.log('no icon'); return }

  async function * source () {
    yield firstContent
    for await (const { payload: evt, error } of iterator) {
      if (error) throw error
      yield evt.content
    }
  }
  const iconFile = new File(new Base122Decoder(source).getDecoded(), '', mimeType)
  napp.icon = URL.createObjectURL(iconFile)
  napp.dispatchEvent(new CustomEvent('iconready'))
}

async function updateRouteLoadProgress (to) {
  const routeLoadMsg = { code: 'CACHE_APP_FILE', payload: { pathname: window.location.pathname } }

  for await (const { payload: progress, error } of requestMultipleMessages(to, routeLoadMsg)) {
    if (error) { console.log(error); continue }
    napp.progress = progress
    napp.dispatchEvent(new CustomEvent('progress'))
  }
}
