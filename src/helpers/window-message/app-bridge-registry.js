const appBridgeStates = new Map()
let createAppBridgeSignal = () => {
  throw new Error('App bridge signal factory not configured')
}
let appBridgeSpecs

export function registerAppBridgeSignalFactory (factory) {
  createAppBridgeSignal = factory
  appBridgeSpecs = createAppBridgeSignal([])
}

function updateSpecs () {
  const specs = []
  for (const state of appBridgeStates.values()) {
    if (state.windows.size > 0) {
      specs.push({
        key: state.key,
        appId: state.appId,
        userPk: state.userPk,
        appSubdomain: state.appSubdomain
      })
    }
  }
  appBridgeSpecs(specs)
}

export function getAppBridgeSpecs () {
  return appBridgeSpecs
}

export function ensureAppBridgeState (appSubdomain, { userPk, appId }) {
  const key = String(appSubdomain)
  let state = appBridgeStates.get(key)
  if (state) {
    if (state.userPk === userPk && state.appId === appId) return state
    if (state.windows.size === 0) disposeAppBridge(state)
    else throw new Error(`App bridge subdomain ${key} belongs to another app/user`)
  }

  const cachingProgressInner = createAppBridgeSignal({})
  const cachingProgress = (...args) => {
    if (args.length === 0) return cachingProgressInner()
    const nextValue = typeof args[0] === 'function'
      ? args[0](cachingProgressInner())
      : args[0]
    cachingProgressInner(nextValue)
    state.progressSinks.forEach(sink => sink(nextValue))
    return nextValue
  }
  cachingProgress.set = cachingProgressInner.set.bind(cachingProgressInner)

  state = {
    key,
    userPk,
    appId,
    appSubdomain: key,
    appFilesPromise: null,
    appFiles: null,
    ready$: createAppBridgeSignal(false),
    error$: createAppBridgeSignal(null),
    generation$: createAppBridgeSignal(0),
    retryCount$: createAppBridgeSignal(0),
    trustedIframeRef$: createAppBridgeSignal(null),
    trustedIframeSrc$: createAppBridgeSignal('about:blank'),
    windows: new Map(),
    progressSinks: new Set(),
    cachingProgress$: cachingProgress,
    currentPort: null,
    currentPortAbortController: null,
    nfileDownloads: new Map(),
    nostrDbSubscriptions: new Map(),
    bridgeErrorHandler: null,
    disposeTimer: null,
    bridgeCleanup: null,
    bridgeRetryState: null
  }
  appBridgeStates.set(key, state)
  return state
}

export function getAppBridgeState (appSubdomain) {
  return appBridgeStates.get(String(appSubdomain)) || null
}

export function registerAppBridgeWindow (state, entry) {
  state.windows.set(entry.appKey, entry)
  if (entry.cachingProgress$) state.progressSinks.add(entry.cachingProgress$)
  if (state.disposeTimer) {
    clearTimeout(state.disposeTimer)
    state.disposeTimer = null
  }
  updateSpecs()
  return function unregister () {
    state.windows.delete(entry.appKey)
    state.progressSinks.delete(entry.cachingProgress$)
    if (state.windows.size === 0 && !state.disposeTimer) {
      state.disposeTimer = setTimeout(() => disposeAppBridge(state), 30000)
    }
    updateSpecs()
  }
}

export function disposeAppBridge (state) {
  if (state.windows.size > 0) return
  clearTimeout(state.disposeTimer)
  state.disposeTimer = null
  state.bridgeCleanup?.()
  state.bridgeCleanup = null
  state.appFilesPromise = null
  state.appFiles = null
  state.ready$(false)
  state.error$(null)
  appBridgeStates.delete(state.key)
  updateSpecs()
}
