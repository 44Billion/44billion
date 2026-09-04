import { tell, ask } from '#helpers/window-message/index.js'
import { injectEventStore } from '#helpers/window-message/nostrdb-client.js'
import { createAppLocaleClient } from '#helpers/window-message/app-locale-client.js'
import { naddrDecode } from 'libp2r2p/nip19'
import {
  DRAFT_SITE_MANIFEST,
  MAIN_SITE_MANIFEST,
  NEXT_SITE_MANIFEST
} from 'libp2r2p/kind'

// Apps (and widgets, which are app instances) run in this document, and their
// console output is often noisy. Route their log methods through
// `console.debug` so they only appear at the verbose level, while keeping our
// own messages on the original methods below.
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
}
const appConsoleDebug = originalConsole.debug || originalConsole.log
console.log = (...args) => appConsoleDebug(...args)
console.info = (...args) => appConsoleDebug(...args)
console.warn = (...args) => appConsoleDebug(...args)
console.error = (...args) => appConsoleDebug(...args)

// Temporary widget-drag instrumentation: only log in development builds.
const widgetDragLog = (...args) => {
  if (IS_DEVELOPMENT) originalConsole.log(...args)
}

const SITE_MANIFEST_KINDS = new Set([
  MAIN_SITE_MANIFEST,
  NEXT_SITE_MANIFEST,
  DRAFT_SITE_MANIFEST
])

const localeClient = createAppLocaleClient({
  reportError: error => originalConsole.error('window.napp locale listener failed', error)
})

function injectLocale () {
  Object.assign(window.napp, {
    getLocale: localeClient.getLocale,
    onLocaleChanged: localeClient.onLocaleChanged
  })
}

// ERROR: Top-level await is currently not supported with the "iife" output format [plugin js-text]
// https://github.com/evanw/esbuild/issues/253
(async () => {
  stripBridgeMarker()
  hideAutoFitContent()
  const p = Promise.withResolvers()
  injectNip07(p.promise) // first thing
  injectLocale()
  injectEventStore(window, p.promise)
  interceptNavigations(p.promise)
  reportRouteChanges(p.promise)
  tellParentImReady(p)
  try {
    await preventSwUsage()
  } catch (error) {
    originalConsole.warn('[app-page] Failed to prevent service worker usage', error)
  }
  await p.promise
  startAutoFit()
})()

// Removes the launcher-internal bridge marker from the URL before the app's
// own scripts run. The service worker already used it to route the first
// requests to the trusted iframe of the correct tab.
function stripBridgeMarker () {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('~~bridgeId')) return
  url.searchParams.delete('~~bridgeId')
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

async function preventSwUsage () {
  const registration = await navigator.serviceWorker.ready

  // Stub the methods to prevent napps from using them
  Object.defineProperties(registration, {
    unregister: {
      value () {
        originalConsole.warn('Napps can\'t unregister service workers')
        return Promise.resolve(true)
      }
    },
    addEventListener: {
      value () { originalConsole.warn('Napps can\'t add event listeners to service worker registrations') }
    },
    removeEventListener: {
      value () { originalConsole.warn('Napps can\'t remove event listeners from service worker registrations') }
    }
  })

  navigator.serviceWorker.register = function () {
    originalConsole.warn('Napps can\'t register service workers')
    return Promise.resolve(registration)
  }
  Object.defineProperty(navigator.serviceWorker, 'ready', {
    get () {
      originalConsole.warn('Napps can\'t wait for service worker activation')
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
    autoFitEnabled = true
    autoFitIsWidget = e.data.payload?.isWidget === true
    autoFitPort = browserPort
    widgetDragLog('[widget-drag] browser-ready', {
      isWidget: autoFitIsWidget,
      hasPort: !!autoFitPort
    })
    localeClient.setLocale(e.data.payload?.locale)
    const bridgeId = e.data.payload?.bridgeId
    if (bridgeId) {
      navigator.serviceWorker?.controller?.postMessage({
        code: 'APP_PAGE_BRIDGE',
        payload: { bridgeId }
      })
    }
    document.documentElement.style.overflowX = 'hidden'
    scheduleAutoFitReveal(AUTO_FIT_FIRST_FIT_TIMEOUT_MS)
    p.resolve(browserPort)
  }, { once: true })
  browserPort.addEventListener('message', e => {
    if (e.data.code === 'LOCALE_CHANGED') localeClient.setLocale(e.data.payload?.locale)
    else if (e.data.code === 'WIDGET_SELECT_MODE') {
      widgetSelectModeEnabled = e.data.payload?.enabled === true
    }
  })
  browserPort.start()
  tell(window.parent, readyMsg, { targetOrigin: '*', transfer: [appPagePortForBrowser] })
}

// Auto-fit: measure horizontal overflow at 100% zoom and apply CSS `zoom` so
// the content fits the instance area (widget cell or app window). The launcher
// cannot read scrollWidth across origins, so this must run inside the app
// page. No app cooperation is required for the default behavior.
const AUTO_FIT_MIN_ZOOM = 0.25
const AUTO_FIT_OVERFLOW_EPSILON = 2
const AUTO_FIT_DEBOUNCE_MS = 150
const AUTO_FIT_REVEAL_TIMEOUT_MS = 1200
const AUTO_FIT_ZOOM_EPSILON = 0.02
const AUTO_FIT_FIRST_FIT_RETRY_MS = 150
const AUTO_FIT_FIRST_FIT_TIMEOUT_MS = 5000
const AUTO_FIT_STABLE_MS = 300
const AUTO_FIT_SETTLE_TIMEOUT_MS = 500
let autoFitEnabled = false
let autoFitIsWidget = false
let autoFitRevealTimer = null
let autoFitDebounceTimer = null
let autoFitFirstFitRetryTimer = null
let autoFitLastWidth = null
let autoFitZoomApplied = null
let autoFitFirstFit = true
let autoFitStartedAt = 0
let autoFitLastMutationAt = 0
let autoFitMutationObserver = null
let autoFitTransitionActive = false
let autoFitPort = null
let widgetSelectModeEnabled = false
let widgetDragListenerStarted = false

function setAutoFitHidden (hidden) {
  document.documentElement.style.visibility = hidden ? 'hidden' : ''
}

function revealAutoFit () {
  clearTimeout(autoFitRevealTimer)
  clearTimeout(autoFitFirstFitRetryTimer)
  autoFitFirstFit = false
  if (autoFitMutationObserver) {
    autoFitMutationObserver.disconnect()
    autoFitMutationObserver = null
  }
  setAutoFitHidden(false)
  if (autoFitEnabled && autoFitPort) {
    tell(autoFitPort, { code: 'AUTO_FIT', payload: { op: 'done' } })
  }
}

function scheduleAutoFitReveal (delay = AUTO_FIT_REVEAL_TIMEOUT_MS) {
  clearTimeout(autoFitRevealTimer)
  autoFitRevealTimer = setTimeout(revealAutoFit, delay)
}

function hideAutoFitContent () {
  setAutoFitHidden(true)
}

function applyAutoFitZoom (zoom) {
  autoFitZoomApplied = zoom
  document.documentElement.style.zoom = zoom < 1 ? String(zoom) : ''
}

// Measures overflow at 100% zoom without ever painting the reset: the
// temporary zoom change and the forced layout happen synchronously, and the
// previous zoom is restored before the browser can render the intermediate
// state.
function computeAutoFitZoom () {
  const root = document.documentElement
  const body = document.body
  const previousZoomStyle = root.style.zoom
  root.style.zoom = ''
  const viewportWidth = root.clientWidth
  const scrollWidth = Math.max(root.scrollWidth, body ? body.scrollWidth : 0)
  root.style.zoom = previousZoomStyle
  autoFitLastWidth = viewportWidth
  if (scrollWidth <= viewportWidth + AUTO_FIT_OVERFLOW_EPSILON) return 1
  const next = Math.max(AUTO_FIT_MIN_ZOOM, Math.min(1, viewportWidth / scrollWidth))
  return Math.round(next * 100) / 100
}

function isAutoFitSettled () {
  const sinceMutation = autoFitLastMutationAt === 0
    ? Date.now() - autoFitStartedAt
    : Date.now() - autoFitLastMutationAt
  const quiet = sinceMutation >= AUTO_FIT_STABLE_MS
  const fontsReady = !document.fonts || document.fonts.status !== 'loading'
  return quiet && fontsReady
}

function waitForAutoFitSettle () {
  const frames = new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  })
  const fonts = document.fonts?.status === 'loading'
    ? Promise.race([
      document.fonts.ready.catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 200))
    ])
    : Promise.resolve()
  return Promise.race([
    Promise.all([frames, fonts]),
    new Promise(resolve => setTimeout(resolve, AUTO_FIT_SETTLE_TIMEOUT_MS))
  ])
}

function isTransparentCssValue (color) {
  const transparentBlack = ['rgba', '(0, 0, 0, 0)'].join('(')
  return !color || color === 'transparent' || color === transparentBlack
}

function getOpaqueAutoFitBackground () {
  const root = document.documentElement
  const rootBg = getComputedStyle(root).getPropertyValue('background-color')
  if (!isTransparentCssValue(rootBg)) return rootBg
  const body = document.body
  if (body) {
    const bodyBg = getComputedStyle(body).getPropertyValue('background-color')
    if (!isTransparentCssValue(bodyBg)) return bodyBg
  }
  return 'canvas'
}

function injectAutoFitTransitionStyles () {
  const style = document.createElement('style')
  style.textContent = `
    ::view-transition-old(root) {
      animation: autoFitHold 250ms ease both;
    }
    ::view-transition-new(root) {
      animation: autoFitReveal 250ms ease both;
    }
    @keyframes autoFitHold {
      0%, 80% { opacity: 1; }
      100% { opacity: 0; }
    }
    @keyframes autoFitReveal {
      0%, 80% { opacity: 0; }
      100% { opacity: 1; }
    }
  `
  document.head.appendChild(style)
}

function scheduleAutoFitFit () {
  clearTimeout(autoFitDebounceTimer)
  autoFitDebounceTimer = setTimeout(fitAutoFit, AUTO_FIT_DEBOUNCE_MS)
}

// Widget drag: the launcher cannot receive pointer events from inside the
// cross-origin app iframe, so this injected listener detects long-press (or a
// plain press while the launcher has selection mode enabled) and forwards
// start/move/end to the launcher through the bridge port.
const WIDGET_DRAG_LONG_PRESS_MS = 600
const WIDGET_DRAG_MOVE_TOLERANCE = 10

function sendWidgetDrag (op, x, y, screenX, screenY) {
  widgetDragLog('[widget-drag] send', op, x, y, {
    hasPort: !!autoFitPort,
    isWidget: autoFitIsWidget,
    screenX,
    screenY
  })
  if (autoFitPort) {
    tell(autoFitPort, {
      code: 'WIDGET_DRAG',
      payload: { op, x, y, screenX, screenY }
    })
  }
}

function installWidgetDragListener () {
  if (widgetDragListenerStarted) return
  widgetDragListenerStarted = true
  // Two-phase lock: selection/callout are disabled as soon as a touch/pen
  // press starts (before the native long-press gesture can claim it), while
  // touch-action is only locked once our drag activates so normal app
  // scrolling keeps working during taps and swipes.
  const setWidgetDragLocked = (locked, { touchAction = false } = {}) => {
    const root = document.documentElement
    const body = document.body
    for (const el of [root, body]) {
      if (!el) continue
      el.style.userSelect = locked ? 'none' : ''
      el.style.webkitUserSelect = locked ? 'none' : ''
      el.style.webkitTouchCallout = locked ? 'none' : ''
      if (touchAction) el.style.touchAction = locked ? 'none' : ''
    }
  }
  const state = {
    pointerId: null,
    startX: 0,
    startY: 0,
    timer: null,
    active: false,
    lastSentX: 0,
    lastSentY: 0
  }
  const clearTimer = () => {
    clearTimeout(state.timer)
    state.timer = null
  }
  const onPointerDown = event => {
    if (!autoFitIsWidget) return
    widgetDragLog('[widget-drag] pointerdown', {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      selectMode: widgetSelectModeEnabled
    })
    if (state.pointerId !== null) return
    state.pointerId = event.pointerId
    state.startX = event.clientX
    state.startY = event.clientY
    state.active = false
    clearTimer()
    const isTouchPointer = event.pointerType === 'touch' || event.pointerType === 'pen'
    if (isTouchPointer) setWidgetDragLocked(true)
    if (widgetSelectModeEnabled) {
      state.active = true
      setWidgetDragLocked(true, { touchAction: true })
      state.lastSentX = event.clientX
      state.lastSentY = event.clientY
      sendWidgetDrag('start', event.clientX, event.clientY, event.screenX, event.screenY)
      return
    }
    state.timer = setTimeout(() => {
      state.timer = null
      state.active = true
      setWidgetDragLocked(true, { touchAction: true })
      state.lastSentX = event.clientX
      state.lastSentY = event.clientY
      widgetDragLog('[widget-drag] long-press fired', {
        x: event.clientX,
        y: event.clientY
      })
      sendWidgetDrag('start', event.clientX, event.clientY, event.screenX, event.screenY)
    }, WIDGET_DRAG_LONG_PRESS_MS)
  }
  const onPointerMove = event => {
    if (!autoFitIsWidget) return
    if (event.pointerId !== state.pointerId) return
    if (state.timer) {
      const dx = event.clientX - state.startX
      const dy = event.clientY - state.startY
      if (Math.abs(dx) > WIDGET_DRAG_MOVE_TOLERANCE || Math.abs(dy) > WIDGET_DRAG_MOVE_TOLERANCE) {
        clearTimer()
      }
      return
    }
    if (!state.active) return
    event.preventDefault()
    if (
      Math.abs(event.clientX - state.lastSentX) >= 2 ||
      Math.abs(event.clientY - state.lastSentY) >= 2
    ) {
      state.lastSentX = event.clientX
      state.lastSentY = event.clientY
      sendWidgetDrag('move', event.clientX, event.clientY, event.screenX, event.screenY)
    }
  }
  const onPointerEnd = event => {
    if (!autoFitIsWidget) return
    if (event.pointerId !== state.pointerId) return
    clearTimer()
    const wasActive = state.active
    state.pointerId = null
    state.active = false
    setWidgetDragLocked(false, { touchAction: true })
    widgetDragLog('[widget-drag] pointerend', {
      x: event.clientX,
      y: event.clientY,
      wasActive
    })
    if (wasActive) {
      sendWidgetDrag('end', event.clientX, event.clientY, event.screenX, event.screenY)
    }
  }
  const onContextMenu = event => {
    if (!autoFitIsWidget) return
    if (state.pointerId !== null) event.preventDefault()
  }
  const onSelectStart = event => {
    if (state.active) event.preventDefault()
  }
  const onDragStart = event => {
    if (state.active) event.preventDefault()
  }
  const onTouchMove = event => {
    if (state.active) event.preventDefault()
  }
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerEnd, true)
  window.addEventListener('pointercancel', onPointerEnd, true)
  window.addEventListener('contextmenu', onContextMenu, true)
  window.addEventListener('selectstart', onSelectStart, true)
  window.addEventListener('dragstart', onDragStart, true)
  window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
}

installWidgetDragListener()

function fitAutoFit () {
  clearTimeout(autoFitDebounceTimer)
  const target = computeAutoFitZoom()
  const current = autoFitZoomApplied ?? 1
  const unchanged = Math.abs(target - current) < AUTO_FIT_ZOOM_EPSILON

  if (unchanged) {
    if (autoFitFirstFit) {
      // The app may not have rendered its layout yet: stay hidden until the
      // DOM has been quiet for a while and fonts are ready, so a "no
      // overflow" measurement is trustworthy.
      if (isAutoFitSettled()) {
        autoFitFirstFit = false
        revealAutoFit()
        return
      }
      clearTimeout(autoFitFirstFitRetryTimer)
      autoFitFirstFitRetryTimer = setTimeout(() => {
        autoFitFirstFitRetryTimer = null
        fitAutoFit()
      }, AUTO_FIT_FIRST_FIT_RETRY_MS)
      return
    }
    revealAutoFit()
    return
  }

  const apply = () => applyAutoFitZoom(target)
  const canTransition = !autoFitFirstFit &&
    typeof document.startViewTransition === 'function' &&
    !document.hidden
  if (canTransition) {
    if (autoFitTransitionActive) {
      scheduleAutoFitFit()
      return
    }
    autoFitTransitionActive = true
    const root = document.documentElement
    const previousBg = root.style.backgroundColor
    const solidBg = getOpaqueAutoFitBackground()
    const needsOpaqueBg = Boolean(solidBg) && isTransparentCssValue(previousBg)
    if (needsOpaqueBg) root.style.backgroundColor = solidBg
    const finishTransition = error => {
      autoFitTransitionActive = false
      if (error) originalConsole.warn('[app-page] Auto-fit view transition failed', error)
      scheduleAutoFitFit()
    }
    try {
      const transition = document.startViewTransition(async () => {
        apply()
        // Keep the old snapshot covering the live content while the browser
        // settles the layout at the new zoom; only after that the new state
        // is captured and the cross-fade starts.
        try {
          await waitForAutoFitSettle()
        } catch (err) {
          originalConsole.error('Error occurred while waiting for auto-fit settle', err)
        } finally {
          if (needsOpaqueBg) root.style.backgroundColor = previousBg
        }
      })
      transition.finished.then(
        () => finishTransition(null),
        finishTransition
      )
    } catch (error) {
      autoFitTransitionActive = false
      originalConsole.warn('[app-page] Auto-fit view transition failed', error)
      if (needsOpaqueBg) root.style.backgroundColor = previousBg
      apply()
    }
    revealAutoFit()
    return
  }
  // Fallback (first fit or no View Transitions support): apply directly. The
  // content is already hidden during the first fit, so never hide an already
  // visible widget here — that would create a blank-frame flicker.
  apply()
  autoFitFirstFit = false
  requestAnimationFrame(revealAutoFit)
}

function startAutoFit () {
  if (!autoFitEnabled) return
  document.documentElement.style.overflowX = 'hidden'
  autoFitStartedAt = Date.now()
  injectAutoFitTransitionStyles()
  const scheduleResize = () => {
    const width = document.documentElement.clientWidth
    if (width === autoFitLastWidth && autoFitZoomApplied !== null) return
    scheduleAutoFitFit()
  }
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(scheduleResize)
    observer.observe(document.documentElement)
  }
  if (document.fonts?.ready) {
    document.fonts.ready.then(scheduleAutoFitFit).catch(() => {})
  }
  if (typeof MutationObserver === 'function') {
    autoFitMutationObserver = new MutationObserver(() => {
      autoFitLastMutationAt = Date.now()
      scheduleAutoFitFit()
    })
    autoFitMutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    })
  }
  window.addEventListener('load', scheduleAutoFitFit)
  window.addEventListener('load', finalizeFirstFit)
  document.addEventListener('load', scheduleAutoFitFit, true)
  fitAutoFit()
}

// First fit must never stay hidden forever: `window.load` is the hard deadline
// for revealing content even if the DOM never settles (apps with continuous
// mutations). A short grace period covers SPAs that render just after load.
function finalizeFirstFit () {
  if (!autoFitFirstFit) return
  if (isAutoFitSettled()) {
    autoFitFirstFit = false
    fitAutoFit()
    return
  }
  setTimeout(() => {
    if (!autoFitFirstFit) return
    autoFitFirstFit = false
    fitAutoFit()
  }, 800)
}

function injectNip07 (promise) {
  const nip07Methods = [
    'peekPublicKey',
    'getPublicKey',
    'signEvent',
    'nip04.encrypt',
    'nip04.decrypt',
    'nip44.encrypt',
    'nip44.decrypt',
    'nip44v3.encrypt',
    'nip44v3.decrypt',
    'nip44v3.encryptDoubleDH',
    'nip44v3.decryptDoubleDH',
    'doubleSignEvent',
    'obfuscate'
  ]
  const nip46MethodAliases = {
    'nip44v3.encryptDoubleDH': 'nip44v3_encrypt_double_dh',
    'nip44v3.decryptDoubleDH': 'nip44v3_decrypt_double_dh'
  }
  function toNip46MethodName (nip07MethodName) {
    if (nip46MethodAliases[nip07MethodName]) return nip46MethodAliases[nip07MethodName]
    return nip07MethodName
      .replace(/\.([a-z])/g, (m, p1) => p1.toUpperCase())
      .replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
  }

  const timeout = 5 * 60 * 1000

  function createNostrMethod (method, context) {
    return (...params) => promise
      .then(browserPort => ask(
        browserPort,
        { code: 'NIP07', payload: { ...context, method, params } },
        { timeout }
      ))
      .then(({ payload, error }) => {
        if (error) throw error
        return payload
      })
  }

  function buildMethodsObject (methods, context) {
    const obj = {}
    methods.map(toNip46MethodName).forEach((nip46MethodName, i) => {
      const originalMethodName = methods[i]
      originalMethodName.split('.').reduce((r, part, j, methodParts) => {
        if (j === methodParts.length - 1) {
          r[part] = createNostrMethod(nip46MethodName, context)
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
  Object.assign(nostr, buildMethodsObject(nip07Methods, { ns: [''] }))

  // Add the namespace method
  nostr.ns = (nsName, ...nsParams) => {
    return buildMethodsObject(nip07Methods, { ns: [nsName, ...nsParams] })
  }

  nostr.withSharedKey = (...withSharedKeyParams) => {
    return buildMethodsObject(nip07Methods, { ns: [''], with_shared_key: withSharedKeyParams })
  }

  // napp methods will use code='WINDOW_NAPP'
  const napp = {}
  napp.getPersonaPublicKeys = () => promise
    .then(browserPort => ask(
      browserPort,
      { code: 'WINDOW_NAPP', payload: { op: 'getPersonaPublicKeys' } }
    ))
    .then(({ payload, error }) => {
      if (error) throw error
      return payload
    })
  napp.getWindowNostrFor = pubkey => {
    const scoped = buildMethodsObject(nip07Methods, { ns: [''], userPk: pubkey })
    scoped.ns = (nsName, ...nsParams) =>
      buildMethodsObject(nip07Methods, { ns: [nsName, ...nsParams], userPk: pubkey })
    scoped.withSharedKey = (...withSharedKeyParams) =>
      buildMethodsObject(nip07Methods, {
        ns: [''],
        with_shared_key: withSharedKeyParams,
        userPk: pubkey
      })
    return scoped
  }
  napp.setMinWidth = minWidth => {
    const value = Math.round(Number(minWidth))
    if (!Number.isFinite(value) || value < 0) {
      originalConsole.warn('[app-page] Invalid setMinWidth value', minWidth)
      return
    }
    if (autoFitPort) {
      tell(autoFitPort, {
        code: 'AUTO_FIT',
        payload: { op: 'setMinWidth', minWidth: value }
      })
    }
  }

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
      // Match patterns like /+abc123, /++abc123, /+++abc123 or /naddr1...
      const encodedAppPattern = /^\/(\+{1,3}[a-zA-Z0-9]{48,}|naddr1[0-9a-z]+)/
      const match = pathname.match(encodedAppPattern)
      if (!match) return false

      // `naddr` carries the event kind itself, so it must be a site manifest
      // to count as an app URL.
      const naddrBody = match[1].replace(/^\+{1,3}/, '')
      if (!naddrBody.startsWith('naddr1')) return true
      try {
        return SITE_MANIFEST_KINDS.has(naddrDecode(naddrBody).kind)
      } catch {
        return false
      }
    } catch (_error) {
      return false
    }
  }

  function handleIntercept (kind, url) {
    if (!shouldInterceptUrl(url)) return false
    const displayUrl = typeof url === 'string'
      ? url
      : (typeof url?.href === 'string' ? url.href : (typeof url?.url === 'string' ? url.url : `${url}`))
    originalConsole.log(`${kind} to`, displayUrl, 'was intercepted and canceled')
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
        originalConsole.log('Link click to', anchor.href, 'was intercepted and canceled')
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
        originalConsole.log('Form submission to', form.action, 'was intercepted and canceled')
        sendOpenAppMessage(form.action)
      }
    }
  }, true)

  // Function to send OPEN_APP message to the parent iframe
  function sendOpenAppMessage (url) {
    try {
      browserPortPromise.then(browserPort => {
        tell(browserPort, {
          code: 'OPEN_APP',
          payload: { href: url }
        })
      }).catch(error => {
        originalConsole.error('Failed to send OPEN_APP message:', error)
      })
    } catch (error) {
      originalConsole.error('Error sending OPEN_APP message:', error)
    }
  }
}

// Reports the app's current route (pathname + search + hash) to the launcher
// so open/minimized windows can be restored at the same URL after a reload.
// SPA navigations are captured by patching the history APIs and listening to
// popstate/hashchange; hard navigations (and the initial load) are covered by
// the report sent as soon as the browser port is ready.
function reportRouteChanges (browserPortPromise) {
  const currentRoute = () => window.location.pathname + window.location.search + window.location.hash
  let latestRoute = null

  function sendRoute (force = false) {
    const route = currentRoute()
    if (!force && route === latestRoute) return
    latestRoute = route
    browserPortPromise.then(browserPort => {
      tell(browserPort, {
        code: 'APP_ROUTE_CHANGED',
        payload: { href: route }
      })
    }).catch(error => {
      originalConsole.error('Failed to send APP_ROUTE_CHANGED:', error)
    })
  }

  const originalPushState = history.pushState
  const originalReplaceState = history.replaceState
  if (typeof originalPushState === 'function') {
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args)
      sendRoute()
      return result
    }
  }
  if (typeof originalReplaceState === 'function') {
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args)
      sendRoute()
      return result
    }
  }
  window.addEventListener('popstate', () => sendRoute())
  window.addEventListener('hashchange', () => sendRoute())
  if ('navigation' in window && typeof window.navigation.addEventListener === 'function') {
    // Fires after a same-document navigation has committed, so `location`
    // already reflects the destination URL (and canceled app-URL
    // navigations are skipped because `location` did not change).
    window.navigation.addEventListener('navigatesuccess', () => sendRoute())
  }
  window.addEventListener('pagehide', () => sendRoute(true))

  sendRoute(true)
}
