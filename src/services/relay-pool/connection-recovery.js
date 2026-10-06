import { isOnline, onOnline } from 'libp2r2p/network'

export const RECOVERABLE_CLOSE_CODES = new Set([1001, 1005, 1006, 1011, 1012, 1013, 1014, 1015])

// Only admits native sockets; never retries operations or trusts app reports.
export class ConnectionRecovery {
  #states = new Map()
  #limits
  #wake
  #checkOnline
  #watchOnline
  #random
  #offline = false
  #probe = null
  #monitor = null
  #counters = { physicalAttempts: 0, deferredConnections: 0, offlineWaits: 0, cancelledBeforeOpen: 0 }

  constructor ({ limits, wake, checkOnline = isOnline, watchOnline = onOnline, random = Math.random }) {
    this.#limits = limits
    this.#wake = wake
    this.#checkOnline = checkOnline
    this.#watchOnline = watchOnline
    this.#random = random
  }

  #state (url) {
    let state = this.#states.get(url)
    if (!state) {
      state = { url, interests: 0, delay: 1000, retryAt: 0, generation: 0, failedGeneration: null, failure: null, recovering: false, trial: null, healthy: new Set(), healthySince: null, stableTimer: null, idleTimer: null, idleSince: null, deferred: new Set() }
      this.#states.set(url, state)
    }
    return state
  }

  retain (url) {
    const state = this.#state(url)
    state.interests++
    state.idleSince = null
    clearTimeout(state.idleTimer)
  }

  release (url) {
    const state = this.#states.get(url)
    if (!state) return
    if (--state.interests === 0) {
      state.idleSince = Date.now()
      this.#expire(state)
    }
    this.#stopNetworkIfIdle()
  }

  #expire (state) {
    clearTimeout(state.idleTimer)
    if (state.interests || state.idleSince === null) return
    state.idleTimer = setTimeout(() => {
      if (!state.interests && !state.healthy.size && state.trial === null) this.#states.delete(state.url)
    }, Math.max(0, state.idleSince + this.#limits.connectionRecoveryIdleMs - Date.now()))
    state.idleTimer.unref?.()
  }

  gate (url, id) {
    if (!this.#limits.physicalBackoffEnabled) return null
    const state = this.#state(url)
    if (globalThis.navigator?.onLine === false) this.#markOffline()
    let wait = null
    if (this.#offline) {
      this.#startMonitor()
      wait = { reason: 'offline' }
    } else if (state.failure) {
      this.#startProbe(state)
      wait = { reason: 'connectivity' }
    } else if (!state.healthy.size && state.retryAt > Date.now()) wait = { reason: 'backoff', until: state.retryAt }
    else if (!state.healthy.size && state.trial !== null) wait = { reason: 'probe' }
    if (wait && !state.deferred.has(id)) {
      state.deferred.add(id)
      this.#counters.deferredConnections++
    }
    return wait
  }

  attempt (url, id) {
    const state = this.#state(url)
    state.deferred.delete(id)
    this.#counters.physicalAttempts++
    if (state.recovering && !state.healthy.size) {
      state.generation++
      state.trial = id
    }
    return state.generation
  }

  opened (url, id) {
    const state = this.#state(url)
    if (!state.healthy.size) state.healthySince = Date.now()
    state.healthy.add(id)
    if (state.failure) {
      state.failure = null
      state.failedGeneration = null
    }
    if (state.trial === id) state.trial = null
    if (state.recovering && !state.stableTimer) {
      state.stableTimer = setTimeout(() => {
        state.stableTimer = null
        if (this.#states.get(url) !== state || !state.healthy.size) return
        state.delay = 1000
        state.retryAt = 0
        state.failedGeneration = null
        state.recovering = false
        this.#wake()
      }, this.#limits.connectionStableMs)
      state.stableTimer.unref?.()
    }
    this.#wake()
  }

  failed (url, id, generation) {
    const state = this.#state(url)
    this.closed(url, id)
    if (!this.#limits.physicalBackoffEnabled || state.healthy.size || state.failedGeneration === generation) return
    state.failedGeneration = generation
    state.recovering = true
    if (!this.#offline && globalThis.navigator?.onLine !== false) state.failure = { at: Date.now() }
    else this.#markOffline()
    this.#wake()
  }

  closed (url, id) {
    const state = this.#states.get(url)
    if (!state) return
    state.healthy.delete(id)
    state.deferred.delete(id)
    if (state.trial === id) state.trial = null
    if (!state.healthy.size) {
      state.healthySince = null
      clearTimeout(state.stableTimer)
      state.stableTimer = null
    }
    this.#expire(state)
    this.#wake()
  }

  cancelledBeforeOpen () { this.#counters.cancelledBeforeOpen++ }
  #hasDemand () { return [...this.#states.values()].some(state => state.interests > 0) }

  #startProbe (state) {
    if (this.#probe) {
      this.#probe.failures.set(state, state.failure)
      return
    }
    const controller = new AbortController()
    const record = { controller, failures: new Map([[state, state.failure]]), timer: null }
    this.#probe = record
    const stopped = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(false), { once: true }))
    record.timer = setTimeout(() => controller.abort(), 6000)
    record.timer.unref?.()
    Promise.race([
      Promise.resolve().then(() => controller.signal.aborted ? false : this.#checkOnline({ signal: controller.signal })).catch(() => false), stopped
    ]).then(online => {
      if (this.#probe !== record) return
      this.#probe = null
      clearTimeout(record.timer)
      controller.abort()
      const pending = [...record.failures].filter(([item, failure]) => this.#states.get(item.url) === item && item.failure === failure && !item.healthy.size && item.interests > 0)
      if (!pending.length) { this.#wake(); return }
      if (!online || globalThis.navigator?.onLine === false) this.#markOffline()
      else {
        for (const [item, failure] of pending) {
          item.failure = null
          item.retryAt = failure.at + Math.round(Math.min(this.#limits.connectionBackoffMaxMs, item.delay * (0.8 + this.#random() * 0.4)))
          item.delay = Math.min(item.delay * 2, this.#limits.connectionBackoffMaxMs)
        }
      }
      this.#wake()
    })
  }

  #markOffline () {
    if (!this.#offline) this.#counters.offlineWaits++
    this.#offline = true
    for (const state of this.#states.values()) state.failure = null
    this.#cancelProbe()
    this.#startMonitor()
  }

  #startMonitor () {
    if (this.#monitor || !this.#hasDemand()) return
    const monitor = { stop: () => {}, ended: false }
    this.#monitor = monitor
    monitor.stop = this.#watchOnline(() => {
      if (this.#monitor !== monitor || globalThis.navigator?.onLine === false) return
      this.#offline = false
      this.#stopMonitor()
      this.#wake()
    })
    if (monitor.ended) monitor.stop()
  }

  #stopMonitor () {
    const monitor = this.#monitor
    if (!monitor) return
    this.#monitor = null
    monitor.ended = true
    monitor.stop()
  }

  #cancelProbe () {
    const probe = this.#probe
    this.#probe = null
    if (!probe) return
    clearTimeout(probe.timer)
    probe.controller.abort()
  }

  #stopNetworkIfIdle () {
    if (this.#hasDemand()) return
    this.#cancelProbe()
    this.#stopMonitor()
  }

  snapshot () {
    return {
      ...this.#counters, offline: this.#offline, checking: this.#probe !== null,
      urls: [...this.#states.values()].slice(-32).map(state => ({
        relay: state.url, nextDelayMs: state.delay, retryAt: state.retryAt,
        recovering: state.recovering, pendingFailure: state.failure !== null,
        checking: state.failure !== null && this.#probe?.failures.get(state) === state.failure,
        trial: state.trial !== null, healthySockets: state.healthy.size,
        healthySince: state.healthySince, interests: state.interests
      }))
    }
  }

  clear () {
    this.#cancelProbe()
    this.#stopMonitor()
    for (const state of this.#states.values()) {
      clearTimeout(state.stableTimer)
      clearTimeout(state.idleTimer)
    }
    this.#states.clear()
    this.#offline = false
  }
}
