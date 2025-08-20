import { requestMultipleMessages } from '#helpers/window-message/index.js'
import { appSubdomainToAppId, appIdToAddressObj } from '#helpers/app.js'
import Base122Decoder from '#services/base122-decoder.js'
import { triggerReloadOnSwSkipWaiting } from '#helpers/service-worker.js'

const napp = new class extends EventTarget {
  icon = null
  progress = null
}()
window.napp = napp
const to = window.parent
const appId = appSubdomainToAppId(location.hostname.split('.')[0])
const appAddress = appIdToAddressObj(appId)

async function maybeSetIcon () {
  const iconMsg = { code: 'GET_APP_ICON_CHUNKS', payload: { appAddress } }
  const iterator = requestMultipleMessages(to, iconMsg, { targetOrigin: '*' })
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

async function updateRouteLoadProgress () {
  const filename = window.location.pathname.slice(1)
  const routeLoadMsg = { code: 'CACHE_APP_FILE', payload: { appAddress, filename } }

  for await (const { payload: progress, error } of requestMultipleMessages(to, routeLoadMsg, { targetOrigin: '*' })) {
    if (error) { console.log(error); continue }
    napp.progress = progress
    napp.dispatchEvent(new CustomEvent('progress'))
  }
}

triggerReloadOnSwSkipWaiting()
maybeSetIcon()
updateRouteLoadProgress()
