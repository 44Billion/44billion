// we use an always-on trusted app page to add a 'message' listener to
// instead of injecting it to all (loaded) regular app pages
// this page is an iframe at a trusted html generated and served by the sw,
// loaded at <appid>.44billion.net/~~napp
// being the first hop of sw-to-browser communication
import { BASE62_ALPHABET } from '#helpers/base62.js'
import { postMessage } from '../index.js'

const swOrigin = window.location.origin // same as app's origin
let userPageOrigin

export function initMessageListener () {
  window.addEventListener('message', async e => {
    switch (e.data.code) {
      case 'REPLY': {
        if (
          !userPageOrigin &&
          new RegExp(`^u[${BASE62_ALPHABET}]{43}$`).test(e.origin.split('.')[0])
        ) userPageOrigin = e.origin
        // forward down
        if (e.origin !== userPageOrigin) return
        // sending to sw with regular (no port) postMessage works
        // but the inverse doesn't for some reason (browser bug?)
        // and needs a MessageChannel (that can't be created on sw)
        postMessage(getSw(), e.data, { targetOrigin: swOrigin })

        break
      }
    }
  })

  // Only way that worked for the sw to talk to this page
  // when it didn't have a MessageChannel port sent
  // from this page already
  const bc = new BroadcastChannel('sw~~napp')
  bc.addEventListener('message', e => {
    if (e.data.code !== 'GET_READY_STATUS') return
    tellSwImReady()
  })
}

export async function tellSwImReady () {
  // sw checks this to tell if the iframe is ready
  const readyMsg = {
    code: 'TRUSTED_IFRAME_READY',
    payload: null
  }
  // always create a new one because port2 will be
  // lost when sw gets killed
  const messageChannel = new MessageChannel()
  const port1 = messageChannel.port1
  const port2 = messageChannel.port2

  // This port1 will receive messages from the service worker
  port1.onmessage = (e) => {
    switch (e.data.code) {
      default: {
        // forward up
        if (e.origin !== swOrigin) return
        postMessage(window.parent, e.data) //, { targetOrigin: userPageOrigin ?? '*' })
      }
    }
  }

  postMessage(getSw(), readyMsg, { targetOrigin: swOrigin, transfer: [port2] })
}

// sw needs this iframe ready to bridge communication to app browser
// to load real app page files, so parent will
// wait for this to add real app page iframe to DOM
export function tellParentImReady () {
  const readyMsg = {
    code: 'TRUSTED_IFRAME_READY',
    payload: null
  }

  postMessage(window.parent, readyMsg, { targetOrigin: '*' })
}

function getSw () {
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller
  throw new Error('Should wait')
}
