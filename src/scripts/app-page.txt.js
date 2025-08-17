import { requestMessage } from '#helpers/window-message/index.js'
import { waitUntilSwIsActive, triggerReloadOnSwSkipWaiting } from '#helpers/service-worker.js'

// ERROR: Top-level await is currently not supported with the "iife" output format [plugin js-text]
// https://github.com/evanw/esbuild/issues/253
(async () => {
  await waitUntilSwIsActive()
  triggerReloadOnSwSkipWaiting()

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
    return (...params) => requestMessage(window.parent, { code: 'NIP07', ns: [nsName, ...nsParams], method, params })
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
})()
