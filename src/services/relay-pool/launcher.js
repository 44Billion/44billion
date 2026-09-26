import { freeRelays, nappRelays, relayPool as libRelayPool, seedRelays } from 'libp2r2p/relay'

import { broadcastRelayRegistry } from './bridge-endpoint.js'
import { RELAY_POOL_LIMITS } from './constants.js'
import { UnifiedRelayPool } from './pool.js'
import { RelayRegistry } from './registry.js'
import { createRelayPoolWebSocketClass } from './virtual-socket.js'

const OriginalWebSocket = globalThis.WebSocket
const log = (...args) => console.debug('[relay-pool]', ...args)

export const relayRegistry = new RelayRegistry([...seedRelays, ...freeRelays, ...nappRelays])
relayRegistry.subscribe(broadcastRelayRegistry)

export const unifiedRelayPool = new UnifiedRelayPool({
  createSocket: url => new OriginalWebSocket(url),
  registry: relayRegistry,
  limits: RELAY_POOL_LIMITS,
  log
})

const statsTimer = setInterval(() => {
  const snapshot = unifiedRelayPool.snapshot()
  if (snapshot.members > 0 || snapshot.buckets > 0) log('stats', snapshot)
}, 60000)
statsTimer.unref?.()

export function isRelayPoolEnabled () {
  try {
    return localStorage.getItem('config_relayPoolEnabled') !== 'false'
  } catch {
    return true
  }
}

export function setRelayPoolEnabled (enabled) {
  localStorage.setItem('config_relayPoolEnabled', enabled ? 'true' : 'false')
}

let launcherRelayPoolWebSocket = null

export function getLauncherRelayPoolWebSocket () {
  return launcherRelayPoolWebSocket
}

// Installs the pooled WebSocket in the launcher realm and, when the installed
// libp2r2p version supports it, configures the shared RelayPool explicitly.
export function installLauncherRelayPool () {
  if (!isRelayPoolEnabled() || typeof OriginalWebSocket !== 'function') return null
  const RelayPoolWebSocket = createRelayPoolWebSocketClass({
    OriginalWebSocket,
    registry: relayRegistry,
    limits: RELAY_POOL_LIMITS,
    baseUrl: () => document.baseURI,
    onConnectionFailure: (url, info) => unifiedRelayPool.recordFailure(url, info),
    securePage: location.protocol === 'https:',
    log,
    createPoolTransport: ({ url, callbacks, socket }) => {
      if (unifiedRelayPool.isQuarantined(url)) return null
      const member = unifiedRelayPool.attach(url, callbacks, { owner: socket?.relayPoolOwner ?? 'launcher' })
      return {
        send: data => member.send(data),
        close: (code, reason) => member.close(code, reason),
        get bufferedAmount () {
          return member.bufferedAmount
        }
      }
    }
  })
  libRelayPool.setWebSocket?.(RelayPoolWebSocket)
  globalThis.WebSocket = RelayPoolWebSocket
  launcherRelayPoolWebSocket = RelayPoolWebSocket
  return { RelayPoolWebSocket, pool: unifiedRelayPool, registry: relayRegistry }
}

export function relayPoolSnapshot () {
  return unifiedRelayPool.snapshot()
}

if (typeof IS_DEVELOPMENT !== 'undefined' && IS_DEVELOPMENT) {
  globalThis.__44bSetRelayPoolEnabled = enabled => {
    setRelayPoolEnabled(enabled)
    return 'Reload the launcher for the relay pool setting to take effect'
  }
}
