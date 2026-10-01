import { CreditWindow, frameSize } from './bridge-protocol.js'
import { RELAY_BRIDGE, RELAY_POOL_LIMITS } from './constants.js'

const endpoints = new Set()
let endpointSerial = 0
let queueOverflows = 0
const recentOverflows = []
const MAX_RECENT_OVERFLOWS = 16

// Bounded, in-memory diagnostics. Never retain frame contents or filters.
export function relayBridgeSnapshot () {
  const snapshots = [...endpoints].map(endpoint => endpoint.snapshot())
  const queues = snapshots.flatMap(snapshot => snapshot.queues)
  return {
    endpoints: endpoints.size,
    attachments: snapshots.reduce((total, snapshot) => total + snapshot.attachments, 0),
    queuedFrames: queues.reduce((total, queue) => total + queue.queuedFrames, 0),
    queuedBytes: queues.reduce((total, queue) => total + queue.queuedBytes, 0),
    oldestQueuedMs: Math.max(0, ...queues.map(queue => queue.oldestQueuedMs)),
    queues,
    queueOverflows,
    recentOverflows: recentOverflows.map(record => ({ ...record, credit: { ...record.credit }, limits: { ...record.limits }, exceeded: [...record.exceeded] }))
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
    attachment.queue.length = 0
    attachment.queuedBytes = 0
    attachment.grantedFrames = 0
    attachment.grantedBytes = 0
  }

  const queueSnapshot = attachment => ({
    endpointId,
    virtualId: attachment.virtualId,
    owner,
    relay: attachment.url,
    queuedFrames: attachment.queue.length,
    queuedBytes: attachment.queuedBytes,
    oldestQueuedMs: attachment.queue.length ? Math.max(0, now() - attachment.queue[0].queuedAt) : 0,
    headFrameBytes: attachment.queue[0]?.size ?? 0,
    peakQueuedFrames: attachment.peakQueuedFrames,
    peakQueuedBytes: attachment.peakQueuedBytes,
    credit: attachment.credit.snapshot()
  })

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

  const dropAttachment = (virtualId, code = 1013, reason = 'relay bridge closed', wasClean = false) => {
    const attachment = attachments.get(virtualId)
    if (!attachment) return
    releaseAttachment(attachment)
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
    if (!isActive(attachment)) return
    const size = frameSize(data)
    if (attachment.queue.length > 0 || !attachment.credit.canSend(size)) {
      attachment.queue.push({ data, size, queuedAt: now() })
      attachment.queuedBytes += size
      attachment.peakQueuedFrames = Math.max(attachment.peakQueuedFrames, attachment.queue.length)
      attachment.peakQueuedBytes = Math.max(attachment.peakQueuedBytes, attachment.queuedBytes)
      if (attachment.queue.length > limits.maxQueuedFramesPerMember || attachment.queuedBytes > limits.maxQueuedBytesPerMember) {
        const record = {
          ...queueSnapshot(attachment),
          timestamp: Date.now(),
          direction: 'launcher-to-consumer',
          limits: { frames: limits.maxQueuedFramesPerMember, bytes: limits.maxQueuedBytesPerMember },
          exceeded: [
            ...(attachment.queue.length > limits.maxQueuedFramesPerMember ? ['frames'] : []),
            ...(attachment.queuedBytes > limits.maxQueuedBytesPerMember ? ['bytes'] : [])
          ]
        }
        queueOverflows++
        recentOverflows.push(record)
        if (recentOverflows.length > MAX_RECENT_OVERFLOWS) recentOverflows.shift()
        log('relay endpoint queue overflow', record)
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
      log('delegated socket creation failed', url, error?.message ?? error)
    }
    if (!socket) {
      releaseAttachment(attachment)
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
          peakQueuedFrames: 0,
          peakQueuedBytes: 0,
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
    snapshot: () => ({
      attachments: attachments.size,
      queues: [...attachments.values()].filter(attachment => attachment.queue.length > 0).map(queueSnapshot)
    }),
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
