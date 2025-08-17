export async function waitUntilSwIsActive (pathname = '/sw.js') {
  // no-op during subsequent visits
  await navigator.serviceWorker.register(pathname)
  await navigator.serviceWorker.ready
}

export function checkForSwUpdatesFrequently () {
  // check for sw updates besides the browser auto checks
  setInterval(() => registration.update(), 60 * 60 * 1000)
}

export function triggerReloadOnSwSkipWaiting (url) {
  // fired by sw.skipWaiting()
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (url) window.location.replace(url)
    else window.location.reload()
  }, { once: true })
}

// export function navigateToRootOnSwSkipWaiting () {
//   // fired by sw.skipWaiting()
//   navigator.serviceWorker.addEventListener('controllerchange', () => {
//     window.location.pathname = '/'
//   }, { once: true })
// }
