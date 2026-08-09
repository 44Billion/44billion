import { toSignal } from '#f'
import { checkForSwUpdatesFrequently } from './service-worker.js'

// Reactive state of the launcher update flow, shared with the toolbar more
// menu and the launcher-update-dialog component: 'none' (no pending update),
// 'available' (update dialog shown), 'dismissed' (dialog dismissed, pending
// update surfaced as a persistent menu entry + badge until the user applies
// it). The manager is plain JS outside the component tree, so the shared
// state is a module-level signal rather than a global store hook.
export const launcherUpdateState$ = toSignal('none')

let registrationRef = null
// Only reload after a user-approved skipWaiting, so the first-install
// clients.claim() never causes a surprise reload.
let reloadOnControllerChange = false

export async function initLauncherSw () {
  if (!('serviceWorker' in navigator)) return

  let registration
  try {
    // updateViaCache: 'none' forces the browser to bypass its HTTP cache for
    // the worker script, so a new deploy's sw.js is detected on the next
    // navigation even if a CDN or the browser cached the previous one.
    registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
  } catch (err) {
    console.warn('Failed to register launcher service worker', err?.message ?? err)
    return
  }
  registrationRef = registration

  checkForSwUpdatesFrequently(registration)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') registration.update()
  })

  // Fired when a user-approved skipWaiting makes the new worker take control
  // (the launcher SW calls clients.claim() on activate).
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadOnControllerChange) return
    reloadOnControllerChange = false
    window.location.reload()
  })

  // A worker can already be waiting (e.g. the update was detected on a
  // previous load and the user never applied it).
  if (registration.waiting) {
    launcherUpdateState$('available')
    return
  }

  registration.addEventListener('updatefound', () => {
    const newWorker = registration.installing
    if (!newWorker) return
    newWorker.addEventListener('statechange', () => {
      // Installed but not activated: there is a newer worker than the one
      // controlling this page, so an update is waiting for the user.
      if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
        launcherUpdateState$('available')
      }
    })
  })
}

export function applyLauncherUpdate () {
  const registration = registrationRef
  if (!registration?.waiting) return
  // Hide the dialog and keep the menu entry + toggle badge visible until the
  // reload applies the new version (controllerchange below).
  launcherUpdateState$('dismissed')
  reloadOnControllerChange = true
  registration.waiting.postMessage({ code: 'SKIP_WAITING' })
}

export function dismissLauncherUpdate () {
  launcherUpdateState$('dismissed')
}
