import AppUpdater from '#services/app-updater/index.js'
import { readLocalApps } from './state.js'
import { installLocalBuild } from './install.js'
import { notifyLocalInstances } from './instances.js'
import './reset-button.js'

const queues = new Map()

// A single worker per project installs the latest announced build, with cross-tab locks.
async function synchronize (project) {
  let queue = queues.get(project)
  if (queue) { queue.pending = true; return queue.promise }
  queue = { pending: true }
  queues.set(project, queue)
  queue.promise = (async () => {
    let installed
    while (queue.pending) {
      queue.pending = false
      const response = await fetch(`/__dev/apps/build?project=${encodeURIComponent(project)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('The local watcher is not serving this app')
      const build = await response.json()
      try {
        const changed = await installLocalBuild(build, {
          loadAsset: async asset => {
            const url = `/__dev/apps/file?${new URLSearchParams({ project, revision: build.revision, root: asset.root })}`
            const response = await fetch(url, { cache: 'no-store' })
            if (!response.ok) throw new Error(`Cannot load local file: ${asset.name}`)
            return new Uint8Array(await response.arrayBuffer())
          },
          activate: (...args) => AppUpdater.storeManifestAndRefreshMetadata(...args)
        })
        // Even a tab that lost the install race must refresh its in-memory manager.
        notifyLocalInstances({ type: 'build', appId: build.appId })
        installed = build
        await report(build, changed ? `Installed ${build.revision.slice(0, 12)}` : `Already installed ${build.revision.slice(0, 12)}`)
      } catch (error) {
        await report(build, `Installation failed: ${error.message}`)
        if (!queue.pending) throw error
      }
    }
    return installed
  })().finally(() => queues.delete(project))
  return queue.promise
}

// Reports contain build diagnostics only, never account credentials or app data.
async function report (build, message) {
  console[message.startsWith('Installation failed') ? 'error' : 'info']('[local app]', message)
  await fetch('/__dev/apps/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: build.project, revision: build.revision, message }) }).catch(() => {})
}

// An explicit local link admits an installation; announcements alone cannot install apps.
export async function startLocalApps () {
  const requested = new URL(location.href).searchParams.get('local-dev')
  const events = new EventSource('/__dev/apps/events')
  events.addEventListener('build', event => {
    const build = JSON.parse(event.data)
    if (build.project !== requested && !Object.values(readLocalApps()).some(record => record.project === build.project)) return
    synchronize(build.project).catch(error => console.error('[local app]', error.message))
  })
  if (requested) {
    try {
      const build = await synchronize(requested)
      if (build) location.replace(`/${build.app}`)
    } catch (error) {
      console.error('[local app]', error)
      // Leave the launcher usable so the developer can retry the same link.
    }
  }
}
