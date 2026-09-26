import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  installInsecureWebSocketGuard,
  upgradeInsecureWebSocketUrl
} from '#helpers/insecure-websocket-guard.js'

const SECURE_PAGE = 'https://app.example/window/'

describe('insecure WebSocket guard', () => {
  it('upgrades cleartext ws and http URLs to their TLS schemes', () => {
    assert.equal(upgradeInsecureWebSocketUrl('ws://relay.example/feed', SECURE_PAGE), 'wss://relay.example/feed')
    assert.equal(upgradeInsecureWebSocketUrl('http://relay.example', SECURE_PAGE), 'https://relay.example/')
    assert.equal(upgradeInsecureWebSocketUrl('wss://relay.example/feed', SECURE_PAGE), 'wss://relay.example/feed')
    assert.equal(upgradeInsecureWebSocketUrl('/relay', SECURE_PAGE), '/relay')
  })

  it('leaves potentially trustworthy and unparsable URLs untouched', () => {
    const untouched = [
      'ws://localhost:7777',
      'ws://vault.localhost:7777',
      'ws://127.0.0.1:7777',
      'ws://127.8.9.10:7777',
      'ws://[::1]:7777',
      'not a url',
      'ftp://relay.example'
    ]
    for (const url of untouched) {
      assert.equal(upgradeInsecureWebSocketUrl(url, SECURE_PAGE), url)
    }
    assert.equal(upgradeInsecureWebSocketUrl(undefined, SECURE_PAGE), undefined)
  })

  it('does not patch pages that are not served over HTTPS', () => {
    class FakeWebSocket {}
    const window = { location: { protocol: 'http:' }, WebSocket: FakeWebSocket }
    installInsecureWebSocketGuard({ window, document: { baseURI: 'http://app.localhost/' }, log: () => {} })
    assert.equal(window.WebSocket, FakeWebSocket)
  })

  it('preserves WebSocket identity, statics and argument shape while upgrading', () => {
    class FakeWebSocket {
      static OPEN = 1

      constructor (...args) {
        this.args = args
      }
    }
    const window = { location: { protocol: 'https:' }, WebSocket: FakeWebSocket }
    const upgrades = []
    installInsecureWebSocketGuard({
      window,
      document: { baseURI: SECURE_PAGE },
      log: (...args) => upgrades.push(args)
    })

    const socket = new window.WebSocket('ws://relay.example/feed', ['nostr'])
    assert.deepEqual(socket.args, ['wss://relay.example/feed', ['nostr']])
    assert.ok(socket instanceof FakeWebSocket)
    assert.ok(socket instanceof window.WebSocket)
    assert.equal(window.WebSocket.OPEN, 1)
    assert.deepEqual(upgrades, [['ws://relay.example/feed', 'wss://relay.example/feed']])
    assert.deepEqual(new window.WebSocket().args, [])
  })

  it('installs the guard only once', () => {
    class FakeWebSocket {
      constructor (url) {
        this.url = url
      }
    }
    const window = { location: { protocol: 'https:' }, WebSocket: FakeWebSocket }
    const document = { baseURI: SECURE_PAGE }
    installInsecureWebSocketGuard({ window, document, log: () => {} })
    const guarded = window.WebSocket
    installInsecureWebSocketGuard({ window, document, log: () => {} })
    assert.equal(window.WebSocket, guarded)
    assert.equal(new window.WebSocket('ws://relay.example/').url, 'wss://relay.example/')
  })
})
