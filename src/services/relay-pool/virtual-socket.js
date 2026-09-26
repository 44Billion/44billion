import { isStrictNostrFrame } from './classify.js'
import { RELAY_POOL_LIMITS } from './constants.js'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

function domException (message, name) {
  return typeof DOMException === 'function'
    ? new DOMException(message, name)
    : Object.assign(new Error(message), { name })
}

function dataByteLength (data) {
  if (typeof data === 'string') return data.length
  if (data instanceof ArrayBuffer) return data.byteLength
  if (ArrayBuffer.isView(data)) return data.byteLength
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size
  return 0
}

function isSendableData (data) {
  return typeof data === 'string' ||
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data) ||
    (typeof Blob !== 'undefined' && data instanceof Blob)
}

function messageEvent (data) {
  if (typeof MessageEvent === 'function') return new MessageEvent('message', { data, origin: '' })
  const event = new Event('message')
  event.data = data
  event.origin = ''
  return event
}

function closeEvent (code, reason, wasClean) {
  if (typeof CloseEvent === 'function') return new CloseEvent('close', { code, reason, wasClean })
  const event = new Event('close')
  event.code = code
  event.reason = reason
  event.wasClean = wasClean
  return event
}

function errorEvent () {
  return new Event('error')
}

function isValidCloseCode (code) {
  return code === 1000 || (code >= 3000 && code <= 4999)
}

// Native WebSocket.prototype exposes url/readyState/protocol/extensions as
// getter-only accessors. Plain assignment in a class constructor would throw
// in strict mode, so define own data properties instead of walking the
// prototype chain.
function defineOwnValue (target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true })
}

// Creates a WebSocket-compatible facade backed by the launcher relay pool.
// The class is intentionally created per realm so `instanceof WebSocket` keeps
// working against that realm's original constructor.
export function createRelayPoolWebSocketClass ({
  OriginalWebSocket,
  registry,
  createPoolTransport,
  onClassified = () => {},
  log = () => {},
  baseUrl,
  securePage = typeof location !== 'undefined' && location.protocol === 'https:',
  limits = RELAY_POOL_LIMITS
}) {
  class RelayPoolWebSocket extends EventTarget {
    static CONNECTING = CONNECTING
    static OPEN = OPEN
    static CLOSING = CLOSING
    static CLOSED = CLOSED

    onopen = null
    onmessage = null
    onerror = null
    onclose = null

    #phase = 'select'
    #pool = null
    #speculative = null
    #direct = null
    #heldClientFrames = []
    #heldServerFrames = []
    #detachQueue = []
    #heldBytes = 0
    #classifyTimer = null
    #detachBytes = 0
    #recentOutbound = []
    #recentBytes = 0
    #ignoreSpeculativeClose = false
    #binaryType = 'blob'

    constructor (url, protocols) {
      super()
      const rawUrl = String(url)
      const normalizedProtocols = protocols === undefined
        ? []
        : (typeof protocols === 'string' ? [protocols] : Array.from(protocols))
      if (normalizedProtocols.length > 0) {
        throw domException("Failed to construct 'WebSocket': the relay pool does not negotiate subprotocols", 'NotSupportedError')
      }
      let parsed
      try {
        parsed = new URL(rawUrl, typeof baseUrl === 'function' ? baseUrl() : baseUrl)
      } catch {
        throw domException(`Failed to construct 'WebSocket': The URL '${rawUrl}' is invalid.`, 'SyntaxError')
      }
      if (parsed.hash) throw domException(`Failed to construct 'WebSocket': The URL '${rawUrl}' contains a fragment.`, 'SyntaxError')
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:'
      else if (parsed.protocol === 'https:') parsed.protocol = 'wss:'
      // Insecure ws:// is blocked as mixed content on HTTPS pages; upgrade
      // before the browser sees it so WebAuthn keeps working.
      if (securePage && parsed.protocol === 'ws:') parsed.protocol = 'wss:'
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        throw domException(`Failed to construct 'WebSocket': The URL's scheme must be either 'ws' or 'wss'. '${parsed.protocol}' is not allowed.`, 'SyntaxError')
      }
      defineOwnValue(this, 'url', parsed.href)
      defineOwnValue(this, 'readyState', CONNECTING)
      defineOwnValue(this, 'protocol', '')
      defineOwnValue(this, 'extensions', '')
      queueMicrotask(() => this.#select())
    }

    get binaryType () {
      return this.#binaryType
    }

    set binaryType (value) {
      if (value !== 'blob' && value !== 'arraybuffer') {
        throw domException(`Failed to set the 'binaryType' property on 'WebSocket': The provided value '${value}' is not a valid enum value of type BinaryType.`, 'SyntaxError')
      }
      this.#binaryType = value
      if (this.#speculative) this.#speculative.binaryType = value
      if (this.#direct) this.#direct.binaryType = value
    }

    get bufferedAmount () {
      let amount = this.#heldBytes + this.#detachBytes
      if (this.#speculative) amount += this.#speculative.bufferedAmount ?? 0
      if (this.#direct) amount += this.#direct.bufferedAmount ?? 0
      if (this.#pool) amount += this.#pool.bufferedAmount ?? 0
      return amount
    }

    send (data) {
      if (this.readyState === CONNECTING) {
        throw domException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError')
      }
      if (this.readyState !== OPEN) return
      if (!isSendableData(data)) {
        throw new TypeError("Failed to execute 'send' on 'WebSocket': The provided value is not of type '(ArrayBuffer or ArrayBufferView or Blob or string)'.")
      }
      this.#rememberOutbound(data)
      const bytes = dataByteLength(data)
      if (this.#phase === 'speculative') {
        if (isStrictNostrFrame(data, 'client')) {
          this.#holdClientFrame(data)
          this.#decidePool()
        } else {
          this.#decideDirect()
          this.#speculative?.send(data)
        }
        return
      }
      if (this.#phase === 'attaching') {
        this.#holdClientFrame(data)
        if (this.#heldBytes > limits.speculativeByteLimit) this.#decideDirect()
        return
      }
      if (this.#phase === 'detaching') {
        this.#detachQueue.push(data)
        this.#detachBytes += bytes
        if (this.#detachQueue.length > limits.maxQueuedFramesPerMember || this.#detachBytes > limits.maxQueuedBytesPerMember) {
          this.#finalizeClose(1013, 'relay pool detach queue overflow', false)
        }
        return
      }
      if (this.#phase === 'pool') {
        this.#pool?.send(data)
        return
      }
      if (this.#phase === 'direct') {
        ;(this.#direct ?? this.#speculative)?.send(data)
      }
    }

    close (code = 1000, reason = '') {
      if (code !== undefined && !isValidCloseCode(code)) {
        throw domException("Failed to execute 'close' on 'WebSocket': The close code must be either 1000 or in the range 3000 to 4999.", 'InvalidAccessError')
      }
      if (this.readyState === CLOSING || this.readyState === CLOSED) return
      if (this.readyState === CONNECTING) {
        this.readyState = CLOSING
        queueMicrotask(() => this.#finalizeClose(1006, '', false))
        this.#disposeTransports()
        return
      }
      this.readyState = CLOSING
      this.#clearClassifyTimer()
      if (this.#phase === 'pool') {
        this.#pool?.close(code, reason)
        return
      }
      const socket = this.#direct ?? this.#speculative
      if (socket) socket.close(code, reason)
      else this.#finalizeClose(1006, '', false)
    }

    #select () {
      if (this.readyState === CLOSED || this.readyState === CLOSING) return
      if (registry?.hasRelay(this.url)) this.#attachPool()
      else this.#openSpeculative()
    }

    #attachPool () {
      this.#phase = 'attaching'
      let handle = null
      try {
        handle = createPoolTransport({
          url: this.url,
          socket: this,
          callbacks: {
            onOpen: info => this.#onPoolOpen(info),
            onMessage: data => this.#deliver(data),
            onClose: info => this.#onTransportClose(info),
            onError: () => this.#onPoolError(),
            onDetach: reason => this.#detachToDirect(reason)
          }
        })
      } catch (error) {
        log('[relay-pool] pool attach failed', this.url, error?.message ?? error)
      }
      if (!handle) {
        if (this.#speculative) this.#decideDirect()
        else this.#openDirectSocket()
        return
      }
      this.#pool = handle
    }

    #openSpeculative () {
      this.#phase = 'speculative'
      let socket
      try {
        socket = new OriginalWebSocket(this.url)
      } catch (error) {
        this.#fail(error)
        return
      }
      socket.binaryType = this.#binaryType
      this.#speculative = socket
      socket.onopen = () => {
        this.extensions = socket.extensions ?? ''
        if (this.readyState === CONNECTING) {
          this.readyState = OPEN
          this.#fire('open')
        }
        this.#startClassifyTimer()
      }
      socket.onmessage = event => this.#onSpeculativeFrame(event.data)
      socket.onerror = () => {
        if (this.#phase === 'speculative' || this.#phase === 'direct') this.#fire('error', errorEvent())
      }
      socket.onclose = event => {
        if (this.#ignoreSpeculativeClose) return
        if (this.#phase === 'speculative' || this.#phase === 'direct') this.#onTransportClose(event)
      }
    }

    #openDirectSocket () {
      this.#phase = 'detaching'
      let socket
      try {
        socket = new OriginalWebSocket(this.url)
      } catch (error) {
        this.#fail(error)
        return
      }
      socket.binaryType = this.#binaryType
      this.#direct = socket
      socket.onopen = () => {
        this.#phase = 'direct'
        this.extensions = socket.extensions ?? ''
        const replay = this.#recentOutbound.filter(item => !item.startsWith('["AUTH"'))
        for (const item of replay) socket.send(item)
        const queued = this.#detachQueue
        this.#detachQueue = []
        this.#detachBytes = 0
        for (const item of queued) socket.send(item)
        if (this.readyState === CONNECTING) {
          this.readyState = OPEN
          this.#fire('open')
        }
      }
      socket.onmessage = event => this.#deliver(event.data)
      socket.onerror = () => this.#fire('error', errorEvent())
      socket.onclose = event => this.#onTransportClose(event)
    }

    #onSpeculativeFrame (data) {
      if (this.#phase !== 'speculative') {
        this.#deliver(data)
        return
      }
      const bytes = dataByteLength(data)
      if (this.#heldServerFrames.length >= limits.speculativeFrameLimit || this.#heldBytes + bytes > limits.speculativeByteLimit) {
        this.#decideDirect()
        this.#deliver(data)
        return
      }
      this.#heldServerFrames.push(data)
      this.#heldBytes += bytes
      if (isStrictNostrFrame(data, 'server')) this.#decidePool()
    }

    #decideDirect () {
      if (this.#phase !== 'speculative') return
      this.#clearClassifyTimer()
      this.#phase = 'direct'
      const serverFrames = this.#heldServerFrames
      const clientFrames = this.#heldClientFrames
      this.#heldServerFrames = []
      this.#heldClientFrames = []
      this.#heldBytes = 0
      for (const frame of serverFrames) this.#deliver(frame)
      for (const frame of clientFrames) this.#speculative?.send(frame)
    }

    #decidePool () {
      if (this.#phase !== 'speculative') return
      this.#clearClassifyTimer()
      this.#phase = 'attaching'
      registry?.addRelay(this.url)
      onClassified(this.url, true)
      this.#attachPool()
    }

    #onPoolOpen (info) {
      if (this.readyState === CLOSING || this.readyState === CLOSED) return
      this.#phase = 'pool'
      this.#closeSpeculativeSilently()
      this.extensions = info?.extensions ?? ''
      if (this.readyState === CONNECTING) {
        this.readyState = OPEN
        this.#fire('open')
      }
      const frames = this.#heldClientFrames
      this.#heldClientFrames = []
      this.#heldServerFrames = []
      this.#heldBytes = 0
      for (const frame of frames) this.#pool?.send(frame)
    }

    #onPoolError () {
      if (this.#phase === 'attaching') {
        this.#pool = null
        if (this.#speculative) this.#decideDirect()
        else this.#openDirectSocket()
      }
    }

    #detachToDirect (reason) {
      if (this.#phase !== 'pool' && this.#phase !== 'attaching') return
      log('[relay-pool] detaching virtual socket to direct', this.url, reason ?? '')
      this.#pool = null
      const socket = this.#speculative
      this.#speculative = null
      if (socket && this.readyState === OPEN && !this.#ignoreSpeculativeClose) {
        // Reuse the speculative socket when it is still healthy.
        this.#phase = 'detaching'
        socket.onmessage = event => this.#deliver(event.data)
        socket.onerror = () => this.#fire('error', errorEvent())
        socket.onclose = event => this.#onTransportClose(event)
        this.#direct = socket
        socket.onopen = null
        this.#phase = 'direct'
        const replay = this.#recentOutbound.filter(item => !item.startsWith('["AUTH"'))
        for (const item of replay) socket.send(item)
        for (const item of this.#detachQueue) socket.send(item)
        this.#detachQueue = []
        this.#detachBytes = 0
        return
      }
      this.#openDirectSocket()
    }

    #closeSpeculativeSilently () {
      const socket = this.#speculative
      this.#speculative = null
      if (!socket) return
      this.#ignoreSpeculativeClose = true
      socket.onclose = null
      socket.onerror = null
      socket.onmessage = null
      try {
        socket.close(1000, '')
      } catch {}
    }

    #onTransportClose (event) {
      const code = typeof event?.code === 'number' && event.code !== 0 ? event.code : 1006
      const reason = typeof event?.reason === 'string' ? event.reason : ''
      const wasClean = event?.wasClean === true
      this.#finalizeClose(code, reason, wasClean)
    }

    #holdClientFrame (data) {
      this.#heldClientFrames.push(data)
      this.#heldBytes += dataByteLength(data)
    }

    #startClassifyTimer () {
      this.#clearClassifyTimer()
      this.#classifyTimer = setTimeout(() => this.#decideDirect(), limits.speculativeDecisionTimeoutMs)
    }

    #clearClassifyTimer () {
      if (this.#classifyTimer === null) return
      clearTimeout(this.#classifyTimer)
      this.#classifyTimer = null
    }

    #rememberOutbound (data) {
      if (typeof data !== 'string') return
      this.#recentOutbound.push(data)
      this.#recentBytes += data.length
      while (this.#recentOutbound.length > limits.replayFrames || this.#recentBytes > limits.replayBytes) {
        const removed = this.#recentOutbound.shift()
        this.#recentBytes -= removed?.length ?? 0
      }
    }

    #deliver (data) {
      if (this.readyState !== OPEN) return
      const event = messageEvent(data)
      this.dispatchEvent(event)
      if (typeof this.onmessage === 'function') this.onmessage(event)
    }

    #fire (type, event = null) {
      const instanceEvent = event ?? new Event(type)
      this.dispatchEvent(instanceEvent)
      const handler = this[`on${type}`]
      if (typeof handler === 'function') handler(instanceEvent)
    }

    #finalizeClose (code, reason, wasClean) {
      if (this.readyState === CLOSED) return
      this.#clearClassifyTimer()
      this.#disposeTransports()
      this.readyState = CLOSED
      this.#fire('close', closeEvent(code, reason, wasClean))
    }

    #fail (error) {
      log('[relay-pool] virtual socket failed', this.url, error?.message ?? error)
      this.#fire('error', errorEvent())
      this.#finalizeClose(1006, '', false)
    }

    #disposeTransports () {
      const pool = this.#pool
      this.#pool = null
      if (pool) {
        try { pool.close(1000, '') } catch {}
      }
      const speculative = this.#speculative
      const direct = this.#direct
      this.#speculative = null
      this.#direct = null
      if (speculative) {
        speculative.onclose = null
        speculative.onerror = null
        speculative.onmessage = null
        try { speculative.close(1000, '') } catch {}
      }
      if (direct && direct !== speculative) {
        direct.onclose = null
        direct.onerror = null
        direct.onmessage = null
        try { direct.close(1000, '') } catch {}
      }
    }
  }

  Object.defineProperties(RelayPoolWebSocket.prototype, {
    CONNECTING: { value: CONNECTING },
    OPEN: { value: OPEN },
    CLOSING: { value: CLOSING },
    CLOSED: { value: CLOSED }
  })
  // Keep `instanceof` working for both the patched global and the original
  // constructor, and inherit the original's static constants/helpers.
  Object.setPrototypeOf(RelayPoolWebSocket.prototype, OriginalWebSocket.prototype)
  for (const key of Object.getOwnPropertyNames(OriginalWebSocket)) {
    if (key === 'prototype' || key === 'length' || key === 'name') continue
    const descriptor = Object.getOwnPropertyDescriptor(OriginalWebSocket, key)
    if (!descriptor || typeof descriptor.value === 'function') continue
    try { Object.defineProperty(RelayPoolWebSocket, key, descriptor) } catch {}
  }
  try {
    Object.defineProperty(RelayPoolWebSocket, 'name', { value: OriginalWebSocket.name || 'WebSocket', configurable: true })
  } catch {}
  return RelayPoolWebSocket
}
