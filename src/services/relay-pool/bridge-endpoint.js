import { CreditWindow, frameSize } from './bridge-protocol.js'
import { RELAY_BRIDGE, RELAY_POOL_LIMITS } from './constants.js'

const endpoints = new Set()

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
  log = () => {}
}) {
  const attachments = new Map()
  let disposed = false

  const send = (code, payload) => {
    if (disposed) return
    port.postMessage({ code, payload })
  }

  const flushGrantedCredit = attachment => {
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

  const dropAttachment = (virtualId, code = 1013, reason = 'relay bridge closed', wasClean = false) => {
    const attachment = attachments.get(virtualId)
    if (!attachment) return
    attachments.delete(virtualId)
    clearTimeout(attachment.timer)
    attachment.suppressClose = true
    closeAttachment(attachment, 1000, '')
    send(RELAY_BRIDGE.CLOSED, { virtualId, code, reason, wasClean })
  }

  const flushAttachment = attachment => {
    while (attachment.queue.length > 0) {
      const item = attachment.queue[0]
      if (!attachment.credit.canSend(item.size)) return
      attachment.queue.shift()
      attachment.queuedBytes -= item.size
      attachment.credit.consume(item.size)
      send(RELAY_BRIDGE.FRAME, { virtualId: attachment.virtualId, data: item.data })
    }
  }

  const deliverFrame = (attachment, data) => {
    const size = frameSize(data)
    if (!attachment.credit.canSend(size)) {
      attachment.queue.push({ data, size })
      attachment.queuedBytes += size
      if (attachment.queue.length > limits.maxQueuedFramesPerMember || attachment.queuedBytes > limits.maxQueuedBytesPerMember) {
        dropAttachment(attachment.virtualId, 1013, 'relay endpoint queue overflow', false)
      }
      return
    }
    attachment.credit.consume(size)
    send(RELAY_BRIDGE.FRAME, { virtualId: attachment.virtualId, data })
  }

  const attachDelegated = (virtualId, url, attachment) => {
    let socket = null
    try {
      socket = createVirtualSocket?.(url)
    } catch (error) {
      log('[relay-pool] delegated socket creation failed', url, error?.message ?? error)
    }
    if (!socket) {
      send(RELAY_BRIDGE.DETACH, { virtualId, reason: 'relay-pool-unavailable' })
      return
    }
    attachment.socket = socket
    try { socket.relayPoolOwner = owner } catch {}
    attachment.timer = setTimeout(() => {
      if (attachment.url) {
        pool.recordFailure(attachment.url, {
          code: 1006,
          reason: 'relay attach timeout',
          phase: 'attach',
          wasClean: false,
          openedAt: null,
          lifetimeMs: null
        })
      }
      dropAttachment(virtualId, 1006, 'relay attach timeout', false)
    }, limits.speculativeDecisionTimeoutMs)
    socket.onopen = () => {
      clearTimeout(attachment.timer)
      send(RELAY_BRIDGE.ATTACHED, {
        virtualId,
        url: socket.url,
        extensions: socket.extensions ?? ''
      })
    }
    socket.onmessage = event => deliverFrame(attachment, event.data)
    socket.onclose = event => {
      attachments.delete(virtualId)
      clearTimeout(attachment.timer)
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
      send(RELAY_BRIDGE.DETACH, { virtualId, reason: 'quarantined' })
      return
    }
    pool.registry.addRelay(url)
    attachment.timer = setTimeout(() => {
      if (attachment.url) {
        pool.recordFailure(attachment.url, {
          code: 1006,
          reason: 'relay attach timeout',
          phase: 'attach',
          wasClean: false,
          openedAt: null,
          lifetimeMs: null
        })
      }
      dropAttachment(virtualId, 1006, 'relay attach timeout', false)
    }, limits.speculativeDecisionTimeoutMs)
    attachment.member = pool.attach(url, {
      onOpen: info => {
        clearTimeout(attachment.timer)
        send(RELAY_BRIDGE.ATTACHED, { virtualId, url, extensions: info?.extensions ?? '' })
      },
      onMessage: data => deliverFrame(attachment, data),
      onClose: info => {
        attachments.delete(virtualId)
        clearTimeout(attachment.timer)
        if (attachment.suppressClose) return
        send(RELAY_BRIDGE.CLOSED, { virtualId, code: info.code, reason: info.reason, wasClean: info.wasClean })
      },
      onDetach: reason => {
        attachments.delete(virtualId)
        clearTimeout(attachment.timer)
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
        pool.recordFailure(payload.url, {
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
          credit: new CreditWindow({ frames: limits.bridgeCreditFrames, bytes: limits.bridgeCreditBytes }),
          queue: [],
          queuedBytes: 0,
          timer: null,
          member: null,
          socket: null,
          grantedFrames: 0,
          grantedBytes: 0,
          creditScheduled: false,
          suppressClose: false
        }
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
        attachment.credit.grant(payload.frames ?? 0, payload.bytes ?? 0)
        flushAttachment(attachment)
        break
      }
      case RELAY_BRIDGE.CLOSE: {
        const attachment = attachments.get(virtualId)
        if (!attachment) return
        attachments.delete(virtualId)
        clearTimeout(attachment.timer)
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
    dispose () {
      if (disposed) return
      disposed = true
      port.removeEventListener('message', onMessage)
      for (const attachment of attachments.values()) {
        clearTimeout(attachment.timer)
        attachment.suppressClose = true
        closeAttachment(attachment, 1000, '')
      }
      attachments.clear()
      endpoints.delete(endpoint)
      log('[relay-pool] endpoint disposed', owner)
    }
  }
  endpoints.add(endpoint)
  return endpoint
}
