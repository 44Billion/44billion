// We use an always-on trusted app page to add a 'message' listener to
// instead of injecting it to all (loaded) regular app pages
// this page is an iframe at a trusted html generated and served by the sw,
// loaded at <appid>.44billion.net/~~napp
// being the first hop of sw-to-browser communication
//
// Note: wildcard certificates for second-level subdomains are hard to get (*.<many>.a.com),
// that's why we can't do  <loggedinuserpubkey>.<appid>.44billion.net
import { postMessage } from '../index.js'

const swOrigin = window.location.origin // same as app's origin
// let browserPort
const { port1: browserPort, port2: trustedAppPagePortForBrowser } = new MessageChannel()
let swPortPromise

let swPort
let trustedAppPagePortForSw

export function initMessageListener () {
  // Only way that worked for the sw to talk to this page
  // when it didn't have a MessageChannel port sent
  // from this page already
  const bc = new BroadcastChannel('sw~~napp')
  bc.addEventListener('message', e => {
    if (e.data.code !== 'GET_READY_STATUS') return
    if (browserPort) tellSwImReady()
  })
}

let ac
export async function tellSwImReady () {
  // sw checks this to tell if the iframe is ready
  const readyMsg = {
    code: 'TRUSTED_IFRAME_READY',
    payload: null
  }
  // always create a new one because port2 will be
  // lost when sw gets killed
  ;({ port1: swPort, port2: trustedAppPagePortForSw } = new MessageChannel())
  let resolve
  ;({ promise: swPortPromise, resolve } = Promise.withResolvers())
  resolve(swPort)

  ac?.abort()
  ac = new AbortController()
  // This port1 will receive messages from the service worker
  swPort.addEventListener('message', e => {
    postMessage(browserPort, e.data)
  }, { signal: ac.signal })
  swPort.start()

  postMessage(getSw(), readyMsg, { targetOrigin: swOrigin, transfer: [trustedAppPagePortForSw] })
}

// sw needs this iframe ready to bridge communication to app browser
// to load real app page files, so parent will
// wait for this to add real app page iframe to DOM
export async function tellParentImReady () {
  const readyMsg = {
    code: 'TRUSTED_IFRAME_READY',
    payload: null
  }

  browserPort.addEventListener('message', async e => {
    switch (e.data.code) {
      case 'REPLY': {
        // forward down
        //
        // Sending to sw with regular (no port) postMessage works
        // but the inverse doesn't for some reason (browser bug?)
        // and needs a MessageChannel (that can't be created on sw)
        // Since we have a channel port, we'll use it
        postMessage(await swPortPromise, e.data, { targetOrigin: swOrigin })
        break
      }
    }
  })
  browserPort.start()
  postMessage(window.parent, readyMsg, { targetOrigin: '*', transfer: [trustedAppPagePortForBrowser] })
}

function getSw () {
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller
  throw new Error('Should wait')
}
