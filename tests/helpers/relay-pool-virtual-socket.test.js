import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import { RelayRegistry } from '#services/relay-pool/registry.js'
import { createRelayPoolWebSocketClass } from '#services/relay-pool/virtual-socket.js'

class FakeOriginalWebSocket extends EventTarget {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances = []

  constructor (url) {
    super()
    this._url = url
    this._readyState = 0
    this._extensions = ''
    this._bufferedAmount = 0
    this.sent = []
    this.closed = null
    FakeOriginalWebSocket.instances.push(this)
  }

  // Native WebSocket exposes these as getter-only accessors.
  get url () { return this._url }
  get readyState () { return this._readyState }
  get protocol () { return '' }
  get extensions () { return this._extensions }
  get bufferedAmount () { return this._bufferedAmount }

  open () {
    this._readyState = 1
    this.onopen?.()
  }

  send (data) {
    this.sent.push(data)
  }

  close (code = 1000, reason = '') {
    this._readyState = 3
    this.closed = { code, reason }
    queueMicrotask(() => this.onclose?.({ code, reason, wasClean: true }))
  }

  message (data) {
    this.onmessage?.({ data })
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

function createFixture (relays = [], options = {}) {
  const registry = new RelayRegistry(relays)
  const attachments = []
  const sent = []
  const RelayPoolWebSocket = createRelayPoolWebSocketClass({
    OriginalWebSocket: FakeOriginalWebSocket,
    registry,
    baseUrl: 'https://app.example/window/',
    ...options,
    createPoolTransport: ({ url, callbacks, socket }) => {
      const attachment = {
        url,
        callbacks,
        socket,
        handle: {
          sent: [],
          bufferedAmount: 0,
          send: data => sent.push(data),
          close: () => {}
        }
      }
      attachments.push(attachment)
      return attachment.handle
    }
  })
  return { registry, attachments, sent, RelayPoolWebSocket }
}

function rawSocket () {
  return FakeOriginalWebSocket.instances.at(-1)
}

describe('relay pool virtual WebSocket', () => {
  beforeEach(() => {
    FakeOriginalWebSocket.instances = []
  })

  it('keeps unknown non-Nostr sockets on a plain 1:1 connection', async () => {
    const { RelayPoolWebSocket, attachments } = createFixture()
    const socket = new RelayPoolWebSocket('wss://generic.example')
    await tick()
    const raw = rawSocket()
    raw.open()
    await tick()
    assert.equal(socket.readyState, socket.OPEN)
    assert.equal(socket instanceof FakeOriginalWebSocket, true)
    assert.equal(socket instanceof RelayPoolWebSocket, true)

    socket.send('hello')
    assert.deepEqual(raw.sent, ['hello'])
    const received = []
    socket.onmessage = event => received.push(event.data)
    raw.message('world')
    assert.deepEqual(received, ['world'])
    assert.equal(attachments.length, 0)
  })

  it('adopts the same connection into the pool on the first strict Nostr frame', async () => {
    const { RelayPoolWebSocket, attachments, sent } = createFixture()
    const socket = new RelayPoolWebSocket('wss://relay.example')
    await tick()
    const raw = rawSocket()
    raw.open()
    await tick()
    const request = JSON.stringify(['REQ', 'sub1', { kinds: [1] }])
    socket.send(request)
    await tick()
    assert.equal(attachments.length, 1)
    assert.deepEqual(raw.sent, [])
    assert.equal(raw.closed, null)

    attachments[0].callbacks.onOpen({ extensions: '' })
    await tick()
    assert.deepEqual(sent, [request])
    assert.equal(socket.readyState, socket.OPEN)
    assert.notEqual(raw.closed, null)
  })

  it('upgrades ws:// to wss:// on HTTPS pages before choosing a transport', async () => {
    const { RelayPoolWebSocket, attachments } = createFixture(['wss://relay.example'], { securePage: true })
    const socket = new RelayPoolWebSocket('ws://relay.example')
    await tick()
    assert.equal(socket.url, 'wss://relay.example/')
    assert.equal(attachments.length, 1)
    assert.equal(FakeOriginalWebSocket.instances.length, 0)
  })

  it('attaches known relays directly without opening a speculative socket', async () => {
    const { RelayPoolWebSocket, attachments } = createFixture(['wss://relay.example'])
    const socket = new RelayPoolWebSocket('wss://relay.example')
    await tick()
    assert.equal(attachments.length, 1)
    assert.equal(FakeOriginalWebSocket.instances.length, 0)
    assert.equal(attachments[0].socket, socket)
    attachments[0].callbacks.onOpen({ extensions: 'permessage-deflate' })
    await tick()
    assert.equal(socket.readyState, socket.OPEN)
    assert.equal(socket.extensions, 'permessage-deflate')
  })

  it('classifies a server-first AUTH challenge as Nostr and discards the stale challenge', async () => {
    const { RelayPoolWebSocket, attachments } = createFixture()
    const socket = new RelayPoolWebSocket('wss://relay.example')
    await tick()
    const raw = rawSocket()
    raw.open()
    await tick()
    const received = []
    socket.onmessage = event => received.push(event.data)
    raw.message(JSON.stringify(['AUTH', 'challenge-from-speculative']))
    await tick()
    assert.equal(attachments.length, 1)
    assert.deepEqual(received, [])
    attachments[0].callbacks.onOpen({})
    await tick()
    attachments[0].callbacks.onMessage(JSON.stringify(['AUTH', 'challenge-from-pool']))
    assert.deepEqual(received, [JSON.stringify(['AUTH', 'challenge-from-pool'])])
  })

  it('throws InvalidStateError when sending before open and closes with 1006 before open', async () => {
    const { RelayPoolWebSocket } = createFixture(['wss://relay.example'])
    const socket = new RelayPoolWebSocket('wss://relay.example')
    assert.throws(() => socket.send('x'), /CONNECTING/)
    const events = []
    socket.onclose = event => events.push([event.code, event.wasClean])
    socket.close(1000, '')
    await tick()
    assert.deepEqual(events, [[1006, false]])
    assert.equal(socket.readyState, socket.CLOSED)
  })

  it('detaches a pooled socket to a direct connection replaying non-AUTH frames', async () => {
    const { RelayPoolWebSocket, attachments } = createFixture(['wss://relay.example'])
    const socket = new RelayPoolWebSocket('wss://relay.example')
    await tick()
    attachments[0].callbacks.onOpen({})
    await tick()
    const event = JSON.stringify(['EVENT', { id: 'x' }])
    socket.send(event)
    socket.send(JSON.stringify(['AUTH', { id: 'auth' }]))
    await tick()
    attachments[0].callbacks.onDetach('quarantined')
    await tick()
    const raw = rawSocket()
    raw.open()
    await tick()
    assert.deepEqual(raw.sent, [event])
    assert.equal(socket.readyState, socket.OPEN)
  })
})
