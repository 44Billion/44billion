import { BASE62_ALPHABET } from '#helpers/base62.js'
import { postMessage } from '../index.js'

// we use an always-on trusted app page to add a 'message' listener to
// instead of injecting it to all (loaded) regular app pages
// this page is an iframe at a trusted html generated and served by the sw,
// loaded at <appid>.44billion.net/~~napp
// being the first hop of sw-to-browser communication
export function initMessageListener () {
  const swOrigin = window.location.origin // same as app's origin
  const sw = navigator.serviceWorker.controller
  let userPageOrigin

  window.addEventListener('message', async e => {
console.log('e.data.code recebido na trustedpage', e.data.code, e.data)

    switch (e.data.code) {
      case 'REPLY': {
        if (
          !userPageOrigin &&
          new RegExp(`^u[${BASE62_ALPHABET}]{43}$`).test(e.origin.split('.')[0])
        ) userPageOrigin = e.origin
        // forward down
        if (e.origin !== userPageOrigin) return
        postMessage(sw, e.data, { targetOrigin: swOrigin })
        break
      }
      default: {
        console.log('uaiiiiiiiiii')
        // forward up
        if (e.origin !== swOrigin) return
        postMessage(window.parent, e.data, { targetOrigin: userPageOrigin ?? '*' })
      }
    }
  })
}

// sw needs this iframe ready to bridge communication to app browser
// to load real app page files
export function tellParentImReady () {
  const readyMsg = {
    code: 'TRUSTED_IFRAME_READY',
    payload: null
  }
  postMessage(window.parent, readyMsg, { targetOrigin: '*' })
}
