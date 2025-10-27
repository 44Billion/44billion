import { postMessage, requestMessage } from '#helpers/window-message/index.js'

// ERROR: Top-level await is currently not supported with the "iife" output format [plugin js-text]
// https://github.com/evanw/esbuild/issues/253
(async () => {
  const p = Promise.withResolvers()
  injectNip07(p.promise) // first thing
  interceptNavigations(p.promise)
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
  const timeout = 5 * 60 * 1000

  function createNostrMethod (method, nsName, nsParams) {
    return (...params) => promise
      .then(browserPort => requestMessage(
        browserPort,
        { code: 'NIP07', payload: { ns: [nsName, ...nsParams], method, params } },
        { timeout }
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

// Intercept and cancel navigations to app URLs
function interceptNavigations (browserPortPromise) {
  const currentHostname = window.location.hostname
  const isLocalhost = currentHostname === 'localhost' || currentHostname.endsWith('.localhost')
  const hasSubdomain = isLocalhost
    ? currentHostname !== 'localhost'
    : currentHostname.split('.').length > 2
  const baseHostname = isLocalhost
    ? 'localhost'
    : hasSubdomain
      ? currentHostname.split('.').slice(-2).join('.')
      : currentHostname

  // If we are at test.example.com we intercept example.com/+[++]aaa...
  // if at test.localhost:8080 we intercept localhost:8080/+[++]aaa...
  function shouldInterceptUrl (url) {
    if (url === undefined || url === null) return false
    const candidateUrl = typeof url === 'string'
      ? url
      : (typeof url?.href === 'string'
          ? url.href
          : (typeof url?.url === 'string' ? url.url : `${url}`))
    if (!candidateUrl || candidateUrl === '[object Object]') return false
    try {
      const urlObj = new URL(candidateUrl, window.location.origin)

      const targetHostname = urlObj.hostname

      // Skip if the navigation goes to a different site
      if (hasSubdomain) {
        if (targetHostname !== baseHostname) return false
      } else {
        if (targetHostname !== currentHostname) return false
      }

      // Check if pathname starts with an encoded app pattern
      const pathname = urlObj.pathname
      // Match patterns like /+abc123, /++abc123, /+++abc123
      const encodedAppPattern = /^\/(\+{1,3}[a-zA-Z0-9]{48,})/
      const match = pathname.match(encodedAppPattern)

      return match !== null
    } catch (_error) {
      return false
    }
  }

  function handleIntercept (kind, url) {
    if (!shouldInterceptUrl(url)) return false
    const displayUrl = typeof url === 'string'
      ? url
      : (typeof url?.href === 'string' ? url.href : (typeof url?.url === 'string' ? url.url : `${url}`))
    console.log(`${kind} to`, displayUrl, 'was intercepted and canceled')
    sendOpenAppMessage(displayUrl)
    return true
  }

  function interceptLocationAPIs () {
    const locationProto = window.Location && window.Location.prototype
    if (!locationProto) return

    // Note: the href setter on Location is not configurable in modern browsers, so
    // direct assignments like `window.location = url` will always win. We still
    // interpose the imperative helpers (assign/replace) to catch the majority of
    // programmatic navigations.
    const locationMethods = ['assign', 'replace']
    for (const methodName of locationMethods) {
      const descriptor = Object.getOwnPropertyDescriptor(locationProto, methodName)
      const originalMethod = descriptor?.value
      if (typeof originalMethod !== 'function') continue

      Object.defineProperty(locationProto, methodName, {
        configurable: true,
        enumerable: descriptor.enumerable,
        writable: true,
        value: function (url, ...args) {
          if (handleIntercept(`window.location.${methodName}`, url)) return
          return originalMethod.call(this, url, ...args)
        }
      })
    }
  }

  function interceptWindowOpen () {
    const originalOpen = window.open
    window.open = function (url, ...args) {
      if (handleIntercept('Window open', url)) return null
      return originalOpen.call(this, url, ...args)
    }
  }

  function interceptNavigationAPI () {
    if (!('navigation' in window) || typeof window.navigation.addEventListener !== 'function') return
    window.navigation.addEventListener('navigate', event => {
      const destinationUrl = event.destination?.url || event.targetLocation?.href || event.detail?.destination?.url
      if (!destinationUrl) return
      if (!handleIntercept('Navigation', destinationUrl)) return
      if (event.cancelable) event.preventDefault()
      if (typeof event.intercept === 'function') {
        try {
          event.intercept({})
        } catch (_error) {
          // ignore
        }
      }
    })
  }

  interceptLocationAPIs()
  interceptWindowOpen()
  interceptNavigationAPI()

  // Intercept link clicks
  document.addEventListener('click', function (e) {
    const anchor = e.target.closest('a')
    if (anchor && anchor.href) {
      if (shouldInterceptUrl(anchor.href)) {
        e.preventDefault()
        console.log('Link click to', anchor.href, 'was intercepted and canceled')
        sendOpenAppMessage(anchor.href)
      }
    }
  }, true)

  // Intercept form submissions
  document.addEventListener('submit', function (e) {
    const form = e.target
    if (form.action) {
      if (shouldInterceptUrl(form.action)) {
        e.preventDefault()
        console.log('Form submission to', form.action, 'was intercepted and canceled')
        sendOpenAppMessage(form.action)
      }
    }
  }, true)

  // Function to send OPEN_APP message to the parent iframe
  function sendOpenAppMessage (url) {
    try {
      browserPortPromise.then(browserPort => {
        postMessage(browserPort, {
          code: 'OPEN_APP',
          payload: { href: url }
        })
      }).catch(error => {
        console.error('Failed to send OPEN_APP message:', error)
      })
    } catch (error) {
      console.error('Error sending OPEN_APP message:', error)
    }
  }
}
