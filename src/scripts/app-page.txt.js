import { postMessage, requestMessage } from '#helpers/window-message/index.js'

// ERROR: Top-level await is currently not supported with the "iife" output format [plugin js-text]
// https://github.com/evanw/esbuild/issues/253
(async () => {
  const p = Promise.withResolvers()
  injectNip07(p.promise) // first thing
  tellParentImReady(p)
  await preventSwUsage()
  await p.promise
})()

async function preventSwUsage () {
  const registration = await navigator.serviceWorker.ready

  // Stub the methods to prevent napps from using them
  Object.defineProperties(registration, {
    unregister: {
      value () {
        console.warn('Napps can\'t unregister service workers')
        return Promise.resolve(true)
      }
    },
    addEventListener: {
      value () { console.warn('Napps can\'t add event listeners to service worker registrations') }
    },
    removeEventListener: {
      value () { console.warn('Napps can\'t remove event listeners from service worker registrations') }
    }
  })

  navigator.serviceWorker.register = function () {
    console.warn('Napps can\'t register service workers')
    return Promise.resolve(registration)
  }
  Object.defineProperty(navigator.serviceWorker, 'ready', {
    get () {
      console.warn('Napps can\'t wait for service worker activation')
      return Promise.resolve(registration)
    }
  })
}

function tellParentImReady (p) {
  const { port1: browserPort, port2: appPagePortForBrowser } = new MessageChannel()
  const readyMsg = {
    code: 'APP_IFRAME_READY',
    payload: null
  }
  browserPort.addEventListener('message', e => {
    if (e.data.code !== 'BROWSER_READY') return p.reject()
    p.resolve(browserPort)
  }, { once: true })
  browserPort.start()
  postMessage(window.parent, readyMsg, { targetOrigin: '*', transfer: [appPagePortForBrowser] })
}

function injectNip07 (promise) {
  const nip07Methods = [
    'peekPublicKey',
    'getPublicKey',
    'signEvent',
    'nip04.encrypt',
    'nip04.decrypt',
    'nip44.encrypt',
    'nip44.decrypt'
  ]
  function toNip46MethodName (nip07MethodName) {
    return nip07MethodName
      .replace(/\.([a-z])/g, (m, p1) => p1.toUpperCase())
      .replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
  }

  const defaultNsName = ''
  const defaultNsParams = []

  function createNostrMethod (method, nsName, nsParams) {
    return (...params) => promise
      .then(browserPort => requestMessage(
        browserPort,
        { code: 'NIP07', payload: { ns: [nsName, ...nsParams], method, params } }
      ))
      .then(({ payload, error }) => {
        if (error) throw error
        return payload
      })
  }

  function buildMethodsObject (methods, nsName, nsParams) {
    const obj = {}
    methods.map(toNip46MethodName).forEach((nip46MethodName, i) => {
      const originalMethodName = methods[i]
      originalMethodName.split('.').reduce((r, part, j, methodParts) => {
        if (j === methodParts.length - 1) {
          r[part] = createNostrMethod(nip46MethodName, nsName, nsParams)
        } else {
          r[part] ??= {}
        }
        return r[part]
      }, obj)
    })
    return obj
  }

  const nostr = {}
  // Add the default methods to nostr
  Object.assign(nostr, buildMethodsObject(nip07Methods, defaultNsName, defaultNsParams))

  // Add the namespace method
  nostr.ns = (nsName, ...nsParams) => {
    return buildMethodsObject(nip07Methods, nsName, nsParams)
  }

  // napp methods will use code='WINDOW_NAPP'
  const napp = {}

  Object.assign(window, { nostr, napp })
}
