import { readLocalApps, isLocalDevApp, installLock, versionLock, userLock } from './state.js'
import { pruneLocalVersions } from './install.js'
import { replaceCachedSiteManifest } from '#services/app-file-manager/manifest-instance-cache.js'
import { getSiteManifestFromDb } from '#services/idb/browser/queries/site-manifest.js'
import { askAppToClearData } from '#zones/screen/helpers/draft-app-runtime-reset.js'
import { base62ToBase16 } from 'libp2r2p/base62'

const instances = new Set()
const channel = new BroadcastChannel('44billion-local-dev')

// The browser releases held locks automatically if a tab closes or crashes.
async function lease (name, signal) {
  const granted = Promise.withResolvers()
  const held = Promise.withResolvers()
  const release = () => held.resolve()
  signal.addEventListener('abort', release, { once: true })
  const request = navigator.locks.request(name, { mode: 'shared', signal }, () => {
    granted.resolve(() => { release(); return request })
    return held.promise
  })
  request.catch(granted.reject).finally(() => signal.removeEventListener('abort', release))
  return granted.promise
}

// Every tab receives the same lifecycle message, including the sending tab.
export function notifyLocalInstances (message) {
  receive(message)
  channel.postMessage(message)
}
function receive (message) {
  for (const instance of instances) {
    if (instance.appId !== message.appId || (message.userPk && instance.userPk !== message.userPk)) continue
    instance.enqueue(message)
  }
}
channel.onmessage = event => receive(event.data)

// Register before the iframe starts; the locks protect its files and user storage.
export async function attachLocalInstance ({ appId, userPk, reload, pause, signal }) {
  if (!isLocalDevApp(appId)) return () => {}
  let releaseUser
  let releaseVersion
  let version
  let paused = false
  let closed = false
  let queue = Promise.resolve()
  const acquire = async () => {
    releaseUser ??= await lease(userLock(appId, userPk), signal)
    await navigator.locks.request(installLock(appId), { signal }, async () => {
      const next = readLocalApps()[appId]?.version
      if (next && next !== version) {
        const release = await lease(versionLock(appId, next), signal)
        releaseVersion?.()
        releaseVersion = release
        version = next
      }
    })
  }
  const instance = {
    appId, userPk,
    enqueue (message) {
      queue = queue.catch(() => {}).then(async () => {
        if (closed) return
        if (message.type === 'pause') {
          paused = true
          await pause()
          await releaseUser?.(); releaseUser = null
          await releaseVersion?.(); releaseVersion = null; version = null
        } else if (message.type === 'resume' || (message.type === 'build' && !paused)) {
          const next = readLocalApps()[appId]?.version
          if (!paused && next === version) return
          const oldRelease = releaseVersion
          releaseVersion = null; version = null
          try {
            await acquire()
            await replaceCachedSiteManifest(appId, await getSiteManifestFromDb(appId))
            await reload()
            paused = false
          } finally { await oldRelease?.() }
          await navigator.locks.request(installLock(appId), () => pruneLocalVersions(appId))
        }
      }).catch(error => { if (!signal.aborted) console.error('[local app]', error) })
    }
  }
  const close = () => {
    closed = true; instances.delete(instance)
    const releases = Promise.allSettled([releaseUser?.(), releaseVersion?.()])
    releaseUser = null; releaseVersion = null
    releases.then(() => navigator.locks.request(installLock(appId), () => pruneLocalVersions(appId))).catch(error => console.warn('[local app] Cleanup deferred', error))
    signal.removeEventListener('abort', close)
  }
  signal.addEventListener('abort', close, { once: true })
  try { await acquire(); signal.throwIfAborted(); instances.add(instance) } catch (error) { close(); throw error }
  return close
}

// Quiesce all instances of one user/app before clearing either storage provider.
export async function clearLocalAppData ({ appId, userPk, appSubdomain }) {
  if (!isLocalDevApp(appId)) throw new Error('This is not a local development app')
  return navigator.locks.request(`local-dev:reset:${appId}:${userPk}`, async () => {
    notifyLocalInstances({ type: 'pause', appId, userPk })
    try {
      // Acquire after each tab has processed its pause request and released its lease.
      await new Promise(resolve => setTimeout(resolve, 100))
      await navigator.locks.request(userLock(appId, userPk), { signal: AbortSignal.timeout(20000) }, async () => {
        const errors = []
        try { await askAppToClearData(appSubdomain, { strict: true, localDevelopment: true }) } catch (error) { errors.push(error) }
        try {
          const { getNostrDb } = await import('#services/idb/nostrdb/index.js')
          const owner = base62ToBase16(userPk, { mode: 'integer', byteLength: 32 }).toLowerCase()
          await getNostrDb(owner).deleteEventsByApp(appId)
        } catch (error) { errors.push(error) }
        if (errors.length) throw new AggregateError(errors, 'Some local app data could not be cleared')
      })
    } finally { notifyLocalInstances({ type: 'resume', appId, userPk }) }
  })
}
