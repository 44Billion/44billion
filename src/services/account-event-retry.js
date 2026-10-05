import { isRetryableRelayFailure } from 'libp2r2p/relay'
import { isOnline, onOnline } from 'libp2r2p/network'
import { ConnectivityRetryCoordinator } from './connectivity-retry.js'

const LOCAL_RETRY_CODES = new Set(['RELAY_READ_QUEUE_FULL', 'RELAY_READ_QUEUE_TIMEOUT', 'RELAY_DISCONNECTED', 'RELAY_LIVE_BUFFER_FULL'])

function pauseUntil (deadline, signal) {
  if (signal.aborted || deadline <= Date.now()) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, Math.max(0, deadline - Date.now()))
    timer.unref?.()
    signal.addEventListener('abort', finish, { once: true })
  })
}

function waitFor (work, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); resolve(false) }
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => {
      signal.removeEventListener('abort', abort); reject(error)
    })
  })
}

export function createAccountEventRetry ({ signal: rootSignal, checkOnline = isOnline, watchOnline = onOnline, random = Math.random }) {
  const connectivity = new ConnectivityRetryCoordinator({
    _onOnline: watchOnline,
    _isOnline: async () => {
      const controller = new AbortController()
      let timer
      let abort
      const interrupted = new Promise(resolve => {
        abort = () => { controller.abort(); resolve(false) }
        rootSignal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(abort, 6000)
        timer.unref?.()
        if (rootSignal.aborted) abort()
      })
      try {
        return await Promise.race([
          Promise.resolve().then(() => checkOnline({ signal: controller.signal })).catch(() => false), interrupted
        ])
      } finally {
        clearTimeout(timer)
        rootSignal.removeEventListener('abort', abort)
        controller.abort()
      }
    }
  })

  return {
    async wait (error, { source, delay, signal }) {
      if (signal.aborted) return null
      if (source === 'local-read') {
        if (!LOCAL_RETRY_CODES.has(error.code)) return null
      } else if (source !== 'storage' && (source !== 'relay' || error.name === 'ValidationError' || !isRetryableRelayFailure(error))) return null

      const failedAt = Date.now()
      const remote = source === 'relay'
      const needsCheck = () => source !== 'storage' && (globalThis.navigator?.onLine === false || (remote && ['connection', 'transport', 'timeout'].includes(error.category)))
      const confirm = () => waitFor(connectivity.confirmOnline({ force: true }), signal)
      const online = !needsCheck() || await confirm()
      if (signal.aborted) return null
      const backoff = Math.min(30000, delay * (0.8 + random() * 0.4))
      const relayDeadline = remote && Number.isFinite(error.retryAt)
        ? error.retryAt
        : remote && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 ? failedAt + Math.min(error.retryAfterMs, 300000) : 0
      const deadline = Math.max(failedAt + (online ? backoff : 0), relayDeadline)
      const nextDelay = online ? Math.min(delay * 2, 30000) : delay
      try {
        if (!online) await connectivity.waitUntilOnline({ signal })
        while (!signal.aborted) {
          await pauseUntil(deadline, signal)
          if (signal.aborted) return null
          if (needsCheck() && !await confirm()) {
            if (signal.aborted) return null
            await connectivity.waitUntilOnline({ signal })
            continue
          }
          return nextDelay
        }
      } catch (failure) { if (!signal.aborted) throw failure }
      return null
    }
  }
}
