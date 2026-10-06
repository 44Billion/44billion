const ORIGINS = Object.freeze({
  RELAY_SOCKET_CLOSED: 'transport',
  RELAY_SOCKET_CONNECT_TIMEOUT: 'transport',
  RELAY_SOCKET_SEND_FAILED: 'transport',
  RELAY_INVALID_SERVER_FRAME: 'protocol',
  RELAY_SOCKET_CREATE_FAILED: 'pool',
  RELAY_POOL_CAPACITY: 'pool',
  RELAY_POOL_REHOME: 'pool',
  RELAY_POOL_QUEUE_OVERFLOW: 'pool',
  RELAY_POOL_INVALID_CLIENT_FRAME: 'pool',
  RELAY_POOL_AUTH_INVALID: 'pool',
  RELAY_POOL_AUTH_TIMEOUT: 'pool',
  RELAY_BRIDGE_ATTACH_TIMEOUT: 'bridge',
  RELAY_BRIDGE_UNAVAILABLE: 'bridge',
  RELAY_BRIDGE_RECEIVE_QUEUE_OVERFLOW: 'bridge',
  RELAY_BRIDGE_FRAME_TOO_LARGE: 'bridge',
  RELAY_BRIDGE_INVALID_CREDIT: 'bridge',
  RELAY_CONSUMER_REPORTED_FAILURE: 'consumer-report'
})
const PHASES = new Set(['connection', 'connect-timeout', 'construct', 'create', 'pool', 'send', 'protocol', 'attach', 'direct', 'speculative', 'bridge', 'auth', 'capacity', 'queue', 'rehome'])

// Diagnostics describe observations by the launcher, not claims in relay frames.
// Keep finite counters and only 32 records; no payloads, filters or identities.
export class RelayDiagnostics {
  #byOrigin = Object.fromEntries([...new Set(Object.values(ORIGINS))].map(origin => [origin, 0]))
  #byCode = {}
  #recent = []
  #log

  constructor (log) { this.#log = log }

  record (code, { relay, phase, closeCode, wasClean, lifetimeMs } = {}) {
    if (!Object.hasOwn(ORIGINS, code)) return
    const origin = ORIGINS[code]
    if (!origin) return
    const record = { at: Date.now(), origin, code, ...(relay ? { relay } : {}) }
    if (PHASES.has(phase)) record.phase = phase
    if (Number.isInteger(closeCode) && closeCode >= 0 && closeCode <= 4999) record.closeCode = closeCode
    if (typeof wasClean === 'boolean') record.wasClean = wasClean
    if (Number.isFinite(lifetimeMs) && lifetimeMs >= 0) record.lifetimeMs = lifetimeMs
    this.#byOrigin[origin]++
    this.#byCode[code] = (this.#byCode[code] || 0) + 1
    this.#recent.push(record)
    if (this.#recent.length > 32) this.#recent.shift()
    this.#log?.('failure diagnostic', { ...record })
  }

  snapshot () {
    return { byOrigin: { ...this.#byOrigin }, byCode: { ...this.#byCode }, recent: this.#recent.map(record => ({ ...record })) }
  }
}
