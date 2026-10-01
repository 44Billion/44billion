import { installInsecureWebSocketGuard } from '#helpers/insecure-websocket-guard.js'

import { CreditWindow, frameSize } from './bridge-protocol.js'
import { RELAY_BRIDGE, RELAY_POOL_LIMITS } from './constants.js'
import { RelayRegistry } from './registry.js'
import { createRelayPoolWebSocketClass } from './virtual-socket.js'

let virtualSerial = 0

function probeRelayNip11 (url, onPositive) {
  const httpUrl = url.replace(/^ws/, 'http')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  fetch(httpUrl, {
    headers: { Accept: 'application/nostr+json' },
    signal: controller.signal,
    credentials: 'omit'
  }).then(response => response.ok ? response.json() : null)
    .then(json => {
      if (json && typeof json === 'object' && (json.name || json.supported_nips || json.version)) onPositive()
    })
    .catch(() => {})
    .finally(() => clearTimeout(timer))
}

export function createBridgeTransport ({ url, callbacks, getPort, limits, log }) {
  const virtualId = `v${++virtualSerial}`
  const sendCredit = new CreditWindow({ frames: limits.bridgeCreditFrames, bytes: limits.bridgeCreditBytes })
  const queue = []
  let queuedBytes = 0
  let port = null
  let attached = false
  let closed = false
  let grantedFrames = 0
  let grantedBytes = 0
  let creditScheduled = false
  let receivedAt = null
  let through
  let portTimer = null

  const flushCredit = () => {
    if (closed || !port || (grantedFrames === 0 && grantedBytes === 0)) return
    port.postMessage({ code: RELAY_BRIDGE.CREDIT, payload: { virtualId, frames: grantedFrames, bytes: grantedBytes, through, receivedAt, returnedAt: performance.timeOrigin + performance.now() } })
    grantedFrames = 0
    grantedBytes = 0
    receivedAt = null
    through = undefined
  }

  const flushQueue = () => {
    while (true) {
      if (queue.length === 0 || !attached || closed) return
      const size = frameSize(queue[0])
      if (!sendCredit.canSend(size)) return
      const data = queue.shift()
      queuedBytes -= size
      sendCredit.consume(size)
      port.postMessage({ code: RELAY_BRIDGE.SEND, payload: { virtualId, data } })
    }
  }

  const fail = reason => {
    if (closed) return
    closed = true
    port?.postMessage({ code: RELAY_BRIDGE.CLOSE, payload: { virtualId, code: 1000, reason: '' } })
    cleanup()
    callbacks.onDetach?.(reason)
  }

  const onMessage = event => {
    const message = event.data
    if (closed || message?.payload?.virtualId !== virtualId) return
    switch (message.code) {
      case RELAY_BRIDGE.ATTACHED:
        clearTimeout(portTimer)
        attached = true
        callbacks.onOpen?.({ extensions: message.payload.extensions ?? '' })
        flushQueue()
        break
      case RELAY_BRIDGE.FRAME: {
        const data = message.payload.data
        receivedAt ??= performance.timeOrigin + performance.now()
        through = message.payload.sequence
        grantedFrames++
        grantedBytes += frameSize(data)
        if (!creditScheduled) {
          creditScheduled = true
          queueMicrotask(() => {
            creditScheduled = false
            flushCredit()
          })
        }
        callbacks.onMessage?.(data)
        break
      }
      case RELAY_BRIDGE.CREDIT:
        sendCredit.grant(message.payload.frames ?? 0, message.payload.bytes ?? 0)
        flushQueue()
        break
      case RELAY_BRIDGE.CLOSED:
        closed = true
        cleanup()
        callbacks.onClose?.({ code: message.payload.code, reason: message.payload.reason, wasClean: message.payload.wasClean })
        break
      case RELAY_BRIDGE.DETACH:
        closed = true
        cleanup()
        callbacks.onDetach?.(message.payload.reason)
        break
    }
  }

  const cleanup = () => {
    clearTimeout(portTimer)
    port?.removeEventListener('message', onMessage)
    queue.length = 0
    queuedBytes = 0
    grantedFrames = 0
    grantedBytes = 0
  }

  getPort().then(resolvedPort => {
    if (closed) return
    port = resolvedPort
    port.addEventListener('message', onMessage)
    port.start()
    port.postMessage({ code: RELAY_BRIDGE.ATTACH, payload: { virtualId, url } })
  }).catch(() => fail('bridge-unavailable'))

  portTimer = setTimeout(() => {
    if (!attached) fail('bridge-timeout')
  }, limits.speculativeDecisionTimeoutMs)

  return {
    get bufferedAmount () {
      return queuedBytes
    },
    send (data) {
      if (closed) return
      const size = frameSize(data)
      if (queue.length > 0 || !attached || !sendCredit.canSend(size)) {
        queue.push(data)
        queuedBytes += size
        if (queue.length > limits.maxQueuedFramesPerMember || queuedBytes > limits.maxQueuedBytesPerMember) {
          closed = true
          port?.postMessage({ code: RELAY_BRIDGE.CLOSE, payload: { virtualId, code: 1000, reason: '' } })
          cleanup()
          callbacks.onClose?.({ code: 1013, reason: 'relay bridge queue overflow', wasClean: false })
        }
        return
      }
      sendCredit.consume(size)
      port.postMessage({ code: RELAY_BRIDGE.SEND, payload: { virtualId, data } })
    },
    close (code, reason) {
      if (closed) return
      closed = true
      clearTimeout(portTimer)
      port?.postMessage({ code: RELAY_BRIDGE.CLOSE, payload: { virtualId, code, reason } })
      cleanup()
      callbacks.onClose?.({ code, reason, wasClean: true })
    },
    start () {},
    get port () {
      return port
    },
    log
  }
}

// Installs the transparent window.WebSocket shim in an app page. The shim is
// the only app-facing surface: no window.napp relay API is added.
export function installRelayPoolWebSocketShim ({
  baseUrl,
  registryUrls = [],
  enabled = true,
  limits = RELAY_POOL_LIMITS,
  log = () => {}
}) {
  const OriginalWebSocket = window.WebSocket
  if (typeof OriginalWebSocket !== 'function') return null
  if (!enabled) {
    installInsecureWebSocketGuard({
      window,
      document,
      log: (url, upgradedUrl) => log('[app-page] Upgraded insecure WebSocket URL', url, '->', upgradedUrl)
    })
    return null
  }
  const registry = new RelayRegistry(registryUrls)
  let enabledRef = enabled !== false
  let resolvePort
  const portPromise = new Promise(resolve => { resolvePort = resolve })
  let appliedRegistry = registryUrls
  let bridgePort = null
  const probed = new Set()
  const pendingFailures = []
  const sendFailure = (url, info) => {
    const payload = { url, ...info }
    if (bridgePort) bridgePort.postMessage({ code: RELAY_BRIDGE.FAILURE, payload })
    else if (pendingFailures.length < 32) pendingFailures.push(payload)
  }

  const RelayPoolWebSocket = createRelayPoolWebSocketClass({
    OriginalWebSocket,
    registry,
    baseUrl,
    securePage: location.protocol === 'https:',
    limits,
    log,
    onClassified: () => {},
    onConnectionFailure: sendFailure,
    createPoolTransport: ({ url, callbacks }) => {
      if (!enabledRef) return null
      if (!probed.has(url)) {
        probed.add(url)
        probeRelayNip11(url, () => {
          registry.addRelay(url)
          bridgePort?.postMessage({ code: RELAY_BRIDGE.REGISTRY_ADD, payload: { url } })
        })
      }
      return createBridgeTransport({
        url,
        callbacks,
        getPort: () => portPromise,
        limits,
        log
      })
    }
  })
  window.WebSocket = RelayPoolWebSocket
  return {
    relayUrls: () => registry.urls(),
    setRelayPort (port) {
      if (!port) return
      bridgePort = port
      for (const payload of pendingFailures.splice(0)) {
        bridgePort.postMessage({ code: RELAY_BRIDGE.FAILURE, payload })
      }
      resolvePort(port)
    },
    setRegistry (urls = []) {
      if (!Array.isArray(urls)) return
      appliedRegistry = urls
      for (const url of urls) registry.addRelay(url)
    },
    setEnabled (value) {
      enabledRef = value !== false
    },
    get registry () {
      return appliedRegistry
    }
  }
}
