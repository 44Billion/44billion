import { createBridgeReceiveQueue } from './bridge-receive-queue.js'
import { frameSize } from './bridge-protocol.js'
import { RELAY_BRIDGE, RELAY_POOL_LIMITS } from './constants.js'

const endpoints = new Set()
let endpointSerial = 0
let queueOverflows = 0
const recentOverflows = []
const MAX_RECENT_OVERFLOWS = 16

// Bounded, in-memory diagnostics. Never retain frame contents or filters.
export function relayBridgeSnapshot () {
  const snapshots = [...endpoints].map(endpoint => endpoint.snapshot())
  const connections = snapshots.flatMap(snapshot => snapshot.connections)
  const queues = connections.filter(connection => connection.queuedFrames > 0)
  return {
    endpoints: endpoints.size,
    attachments: snapshots.reduce((total, snapshot) => total + snapshot.attachments, 0),
    queuedFrames: queues.reduce((total, queue) => total + queue.queuedFrames, 0),
    queuedBytes: queues.reduce((total, queue) => total + queue.queuedBytes, 0),
    oldestQueuedMs: Math.max(0, ...queues.map(queue => queue.oldestQueuedMs)),
    queues,
    connections,
    pendingFrames: connections.reduce((total, item) => total + item.pendingFrames, 0),
    pendingBytes: connections.reduce((total, item) => total + item.pendingBytes, 0),
    queueOverflows,
    recentOverflows: structuredClone(recentOverflows)
  }
}

export function broadcastRelayRegistry (urls) {
  for (const endpoint of endpoints) endpoint.sendRegistry(urls)
}

// Launcher side of the dedicated relay port for one owner (app instance or the
// vault). In app mode each attachment maps to a pool member; in delegated mode
// (the vault) the launcher creates and owns the virtual socket itself, so the
// remote side only has to pipe frames.
export function createRelayBridgeEndpoint ({
  port,
  pool,
  delegate = false,
  createVirtualSocket = null,
  owner = 'app',
  limits = RELAY_POOL_LIMITS,
  log = (...args) => console.debug('[relay-pool]', ...args),
  now = () => performance.now()
}) {
  const endpointId = ++endpointSerial
  const attachments = new Map()
  let disposed = false

  const send = (code, payload) => {
    if (disposed) return
    port.postMessage({ code, payload })
  }

  const isActive = attachment => !disposed && attachments.get(attachment.virtualId) === attachment

  const releaseAttachment = attachment => {
    if (attachments.get(attachment.virtualId) === attachment) attachments.delete(attachment.virtualId)
    clearTimeout(attachment.timer)
    attachment.receive.close()
    attachment.grantedFrames = 0
    attachment.grantedBytes = 0
  }

  const flushGrantedCredit = attachment => {
    if (!isActive(attachment)) return
    if (attachment.grantedFrames === 0 && attachment.grantedBytes === 0) return
    send(RELAY_BRIDGE.CREDIT, {
      virtualId: attachment.virtualId,
      frames: attachment.grantedFrames,
      bytes: attachment.grantedBytes
    })
    attachment.grantedFrames = 0
    attachment.grantedBytes = 0
  }

  const grantSendCredit = (attachment, size) => {
    attachment.grantedFrames++
    attachment.grantedBytes += size
    if (attachment.creditScheduled) return
    attachment.creditScheduled = true
    queueMicrotask(() => {
      attachment.creditScheduled = false
      flushGrantedCredit(attachment)
    })
  }

  const closeAttachment = (attachment, code, reason) => {
    if (attachment.socket) attachment.socket.close(code, reason)
    else attachment.member?.close(code, reason)
  }

  const dropAttachment = (virtualId, code = 1013, reason = 'relay bridge closed', wasClean = false, diagnosticCode) => {
    const attachment = attachments.get(virtualId)
    if (!attachment) return
    if (diagnosticCode) pool.recordDiagnostic?.(diagnosticCode, { relay: attachment.url, phase: 'bridge', closeCode: code, wasClean })
    releaseAttachment(attachment)
    attachment.suppressClose = true
    closeAttachment(attachment, 1000, '')
    send(RELAY_BRIDGE.CLOSED, { virtualId, code, reason, wasClean })
  }

  const deliverFrame = (attachment, data) => {
    if (isActive(attachment)) attachment.receive.push(data)
  }

  const attachDelegated = (virtualId, url, attachment) => {
    let socket = null
    try {
      socket = createVirtualSocket?.(url)
    } catch (error) {
      log('delegated socket creation failed', url, error?.message ?? error)
    }
    if (!socket) {
      pool.recordDiagnostic?.('RELAY_BRIDGE_UNAVAILABLE', { relay: url, phase: 'attach' })
      releaseAttachment(attachment)
      send(RELAY_BRIDGE.DETACH, { virtualId, reason: 'relay-pool-unavailable' })
      return
    }
    attachment.socket = socket
    try { socket.relayPoolOwner = owner } catch {}
    attachment.timer = setTimeout(() => {
      if (attachment.url) {
        pool.recordDiagnostic?.('RELAY_BRIDGE_ATTACH_TIMEOUT', { relay: attachment.url, phase: 'attach', closeCode: 1006 })
      }
      dropAttachment(virtualId, 1006, 'relay attach timeout', false)
    }, limits.speculativeDecisionTimeoutMs)
    socket.onopen = () => {
      if (!isActive(attachment)) return
      clearTimeout(attachment.timer)
      send(RELAY_BRIDGE.ATTACHED, {
        virtualId,
        url: socket.url,
        extensions: socket.extensions ?? ''
      })
    }
    socket.onmessage = event => deliverFrame(attachment, event.data)
    socket.onclose = event => {
      releaseAttachment(attachment)
      if (attachment.suppressClose) return
      send(RELAY_BRIDGE.CLOSED, {
        virtualId,
        code: typeof event?.code === 'number' && event.code !== 0 ? event.code : 1006,
        reason: typeof event?.reason === 'string' ? event.reason : '',
        wasClean: event?.wasClean === true
      })
    }
    socket.onerror = () => {}
  }

  const attachPoolMember = (virtualId, url, attachment) => {
    if (pool.isQuarantined(url)) {
      releaseAttachment(attachment)
      send(RELAY_BRIDGE.DETACH, { virtualId, reason: 'quarantined' })
      return
    }
    pool.registry.addRelay(url)
    attachment.timer = setTimeout(() => {
      if (attachment.url) {
        pool.recordDiagnostic?.('RELAY_BRIDGE_ATTACH_TIMEOUT', { relay: attachment.url, phase: 'attach', closeCode: 1006 })
      }
      dropAttachment(virtualId, 1006, 'relay attach timeout', false)
    }, limits.speculativeDecisionTimeoutMs)
    attachment.member = pool.attach(url, {
      onOpen: info => {
        if (!isActive(attachment)) return
        clearTimeout(attachment.timer)
        send(RELAY_BRIDGE.ATTACHED, { virtualId, url, extensions: info?.extensions ?? '' })
      },
      onMessage: data => deliverFrame(attachment, data),
      onClose: info => {
        releaseAttachment(attachment)
        if (attachment.suppressClose) return
        send(RELAY_BRIDGE.CLOSED, { virtualId, code: info.code, reason: info.reason, wasClean: info.wasClean })
      },
      onDetach: reason => {
        releaseAttachment(attachment)
        send(RELAY_BRIDGE.DETACH, { virtualId, reason })
      }
    }, { owner })
  }

  const onMessage = event => {
    const message = event.data
    const payload = message?.payload
    if (!payload) return
    if (message.code === RELAY_BRIDGE.FAILURE) {
      if (payload.url) {
        pool.recordConsumerFailure?.(payload.url, {
          code: payload.code,
          reason: payload.reason,
          phase: payload.phase,
          wasClean: payload.wasClean,
          openedAt: payload.openedAt,
          lifetimeMs: payload.lifetimeMs
        })
      }
      return
    }
    if (!payload.virtualId) return
    const { virtualId } = payload
    switch (message.code) {
      case RELAY_BRIDGE.ATTACH: {
        if (attachments.has(virtualId)) return
        const attachment = {
          virtualId,
          url: payload.url,
          owner,
          timer: null,
          member: null,
          socket: null,
          grantedFrames: 0,
          grantedBytes: 0,
          creditScheduled: false,
          suppressClose: false
        }
        attachment.receive = createBridgeReceiveQueue({
          endpointId, virtualId, owner, relay: payload.url, limits, now,
          onFrame: (data, sequence) => send(RELAY_BRIDGE.FRAME, { virtualId, data, sequence }),
          onClose: (code, reason, diagnosticCode) => dropAttachment(virtualId, code, reason, false, diagnosticCode),
          onOverflow: details => {
            const record = { ...details, timestamp: Date.now(), direction: 'launcher-to-consumer' }
            queueOverflows++
            recentOverflows.push(record)
            if (recentOverflows.length > MAX_RECENT_OVERFLOWS) recentOverflows.shift()
            log('relay endpoint queue overflow', structuredClone(record))
          }
        })
        attachments.set(virtualId, attachment)
        if (delegate) attachDelegated(virtualId, payload.url, attachment)
        else attachPoolMember(virtualId, payload.url, attachment)
        break
      }
      case RELAY_BRIDGE.REGISTRY_ADD: {
        if (payload.url) pool.registry.addRelay(payload.url)
        break
      }
      case RELAY_BRIDGE.SEND: {
        const attachment = attachments.get(virtualId)
        if (!attachment) return
        if (attachment.socket) attachment.socket.send(payload.data)
        else attachment.member?.send(payload.data)
        grantSendCredit(attachment, frameSize(payload.data))
        break
      }
      case RELAY_BRIDGE.CREDIT: {
        const attachment = attachments.get(virtualId)
        if (!attachment) return
        attachment.receive.grant(payload)
        break
      }
      case RELAY_BRIDGE.CLOSE: {
        const attachment = attachments.get(virtualId)
        if (!attachment) return
        releaseAttachment(attachment)
        if (attachment.socket) {
          attachment.suppressClose = true
          attachment.socket.close(payload.code, payload.reason)
          send(RELAY_BRIDGE.CLOSED, { virtualId, code: payload.code, reason: payload.reason, wasClean: true })
        } else {
          attachment.member?.close(payload.code, payload.reason)
        }
        break
      }
    }
  }

  port.addEventListener('message', onMessage)
  port.start()
  const endpoint = {
    sendRegistry: urls => send(RELAY_BRIDGE.REGISTRY, { urls }),
    snapshot: () => {
      const connections = [...attachments.values()].map(attachment => attachment.receive.snapshot())
      return { attachments: attachments.size, connections, queues: connections.filter(connection => connection.queuedFrames > 0) }
    },
    dispose () {
      if (disposed) return
      disposed = true
      port.removeEventListener('message', onMessage)
      for (const attachment of attachments.values()) {
        releaseAttachment(attachment)
        attachment.suppressClose = true
        closeAttachment(attachment, 1000, '')
      }
      attachments.clear()
      endpoints.delete(endpoint)
    }
  }
  endpoints.add(endpoint)
  return endpoint
}
