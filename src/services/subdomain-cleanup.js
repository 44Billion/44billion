import { askAppToClearData } from '#components/zones/screen/helpers/draft-app-runtime-reset.js'
import {
  normalizeSubdomainMaintenance, readSubdomainLifecycle, subdomainStorage,
  withSubdomainLock, subdomainUseLock, addSubdomainFreeId, isSubdomainMapped
} from '#helpers/subdomain-mapping.js'

let running
let rerun = false
let lastPendingReport

function reportCleanup (completed, pending, reasons, failed) {
  const remaining = [...pending].sort().map(id => ({ id, reason: reasons.get(id) ?? 'Awaiting cleanup' }))
  const signature = JSON.stringify(remaining)
  if (!completed.length && (!remaining.length || signature === lastPendingReport)) {
    if (!remaining.length) lastPendingReport = undefined
    return
  }
  lastPendingReport = remaining.length ? signature : undefined
  const log = failed ? console.warn : console.info
  log(`[subdomain-cleanup] Completed: ${completed.length}; pending: ${remaining.length}`, {
    completed, pending: remaining
  })
}

export function processSubdomainCleanup ({ storage = subdomainStorage(), clear = askAppToClearData, locks = globalThis.navigator?.locks } = {}) {
  if (running) { rerun = true; return running }
  running = (async () => {
    do {
      rerun = false
      const snapshot = await withSubdomainLock(() => normalizeSubdomainMaintenance(storage))
      const completed = []
      const reasons = new Map()
      let failed = false
      if (!locks?.request) {
        for (const id of snapshot.pending) reasons.set(id, 'Web Locks unavailable; recycling disabled')
        reportCleanup(completed, snapshot.pending, reasons, true)
        return
      }
      for (const id of snapshot.pending) {
        try {
          await locks.request(subdomainUseLock(id), { mode: 'exclusive', ifAvailable: true }, async lock => {
            if (!lock) { reasons.set(id, 'Origin in use or cleanup running in another tab'); return }
            const eligible = () => readSubdomainLifecycle(storage).pending.includes(id) && !isSubdomainMapped(storage, id)
            if (!await withSubdomainLock(eligible)) { reasons.set(id, 'Origin still mapped'); return }
            // Catch inside the callback as well: rejected Web Lock callbacks can
            // stall subsequent requests in some runtimes.
            try {
              if (await clear(id, { strict: true }) !== true) throw new Error('Origin cleanup was not confirmed')
              await withSubdomainLock(() => {
                if (!eligible()) { reasons.set(id, 'Origin mapping changed during cleanup'); return }
                const state = readSubdomainLifecycle(storage)
                storage.session_subdomainFreeIds$(addSubdomainFreeId(storage.session_subdomainFreeIds$(), id))
                state.pending = state.pending.filter(value => value !== id)
                storage.local_subdomainLifecycle$(state)
                completed.push(id)
              })
            } catch (error) {
              failed = true
              reasons.set(id, error?.message ?? String(error))
            }
          })
        } catch (error) {
          failed = true
          reasons.set(id, error?.message ?? String(error))
        }
      }
      // Another tab may have completed work or enqueued more origins meanwhile.
      const pending = await withSubdomainLock(() => readSubdomainLifecycle(storage).pending)
      reportCleanup(completed, pending, reasons, failed)
    } while (rerun)
  })().finally(() => { running = null })
  return running
}

export async function reserveSubdomainUse (id, { signal, userPk, appId, storage = subdomainStorage(), locks = globalThis.navigator?.locks } = {}) {
  if (signal.aborted) return false
  const matches = () => {
    const reverse = storage[`session_subdomainToApp_${id}$`]()
    return storage[`session_subdomainByUserAndApp_${userPk}_${appId}$`]() === String(id) &&
      (!reverse || (reverse.userPk === userPk && reverse.appId === appId))
  }
  if (!locks?.request) return matches()
  const ready = Promise.withResolvers()
  locks.request(subdomainUseLock(id), { mode: 'shared', signal }, async () => {
    if (signal.aborted || !matches()) { ready.resolve(false); return }
    await new Promise(resolve => {
      signal.addEventListener('abort', resolve, { once: true })
      ready.resolve(true)
    })
  }).catch(error => {
    if (error.name === 'AbortError') ready.resolve(false)
    else ready.reject(error)
  }).finally(() => {
    globalThis.window?.dispatchEvent(new Event('subdomain-idle'))
  })
  return ready.promise
}
