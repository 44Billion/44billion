import { CreditWindow, frameSize } from './bridge-protocol.js'
import { RELAY_BRIDGE, RELAY_POOL_LIMITS } from './constants.js'

const endpoints = new Set()

export function broadcastRelayRegistry (urls) {
  for (const endpoint of endpoints) endpoint.sendRegistry(urls)
}

// Launcher side of the dedicated relay port for one app instance.
export function createRelayBridgeEndpoint ({ port, pool, limits = RELAY_POOL_LIMITS, log = () => {} }) {
  const attachments = new Map()
  let disposed = false

  const send = (code, payload) => {
    if (disposed) return
    port.postMessage({ code, payload })
  }

  const dropAttachment = (virtualId, code = 1013, reason = 'relay bridge closed', wasClean = false) => {
    const attachment = attachments.get(virtualId)
    if (!attachment) return
    attachments.delete(virtualId)
    clearTimeout(attachment.timer)
    attachment.suppressClose = true
    attachment.member.close(1000, '')
    send(RELAY_BRIDGE.CLOSED, { virtualId, code, reason, wasClean })
  }

  const flushAttachment = attachment => {
    while (attachment.queue.length > 0) {
      const item = attachment.queue[0]
      if (!attachment.credit.canSend(item.size)) return
      attachment.queue.shift()
      attachment.credit.consume(item.size)
      send(RELAY_BRIDGE.FRAME, { virtualId: attachment.virtualId, data: item.data })
    }
  }

  const onMessage = event => {
    const message = event.data
    const payload = message?.payload
    if (!payload?.virtualId) return
    const { virtualId } = payload
    switch (message.code) {
      case RELAY_BRIDGE.ATTACH: {
        if (attachments.has(virtualId)) return
        if (pool.isQuarantined(payload.url)) {
          send(RELAY_BRIDGE.DETACH, { virtualId, reason: 'quarantined' })
          return
        }
        pool.registry.addRelay(payload.url)
        const credit = new CreditWindow({ frames: limits.bridgeCreditFrames, bytes: limits.bridgeCreditBytes })
        const attachment = {
          virtualId,
          credit,
          queue: [],
          queuedBytes: 0,
          timer: null,
          member: null
        }
        attachment.timer = setTimeout(() => dropAttachment(virtualId, 1006, 'relay attach timeout', false), limits.speculativeDecisionTimeoutMs)
        attachment.member = pool.attach(payload.url, {
          onOpen: info => {
            clearTimeout(attachment.timer)
            send(RELAY_BRIDGE.ATTACHED, { virtualId, extensions: info?.extensions ?? '' })
          },
          onMessage: data => {
            const size = frameSize(data)
            if (!credit.canSend(size)) {
              attachment.queue.push({ data, size })
              attachment.queuedBytes += size
              if (attachment.queue.length > limits.maxQueuedFramesPerMember || attachment.queuedBytes > limits.maxQueuedBytesPerMember) {
                dropAttachment(virtualId, 1013, 'relay endpoint queue overflow', false)
              }
              return
            }
            credit.consume(size)
            send(RELAY_BRIDGE.FRAME, { virtualId, data })
          },
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
        })
        attachments.set(virtualId, attachment)
        break
      }
      case RELAY_BRIDGE.REGISTRY_ADD: {
        if (payload.url) pool.registry.addRelay(payload.url)
        break
      }
      case RELAY_BRIDGE.SEND: {
        const attachment = attachments.get(virtualId)
        if (!attachment) return
        attachment.member.send(payload.data)
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
        attachment.member.close(payload.code, payload.reason)
        send(RELAY_BRIDGE.CLOSED, { virtualId, code: payload.code, reason: payload.reason, wasClean: true })
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
        attachment.member.close(1000, '')
      }
      attachments.clear()
      endpoints.delete(endpoint)
      log('[relay-pool] endpoint disposed')
    }
  }
  endpoints.add(endpoint)
  return endpoint
}
