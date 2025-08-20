export async function waitUntilSwIsActive (middleFn = () => {}, pathname = '/sw.js') {
  // no-op during subsequent visits
  await navigator.serviceWorker.register(pathname)
  middleFn() // could be triggerReloadOnSwClientsClaim()
  return navigator.serviceWorker.ready
}

export function checkForSwUpdatesFrequently (registration) {
  // check for sw updates besides the browser auto checks
  setInterval(() => registration.update(), 60 * 60 * 1000)
}

export function triggerReloadOnSwClientsClaim (url) {
  // fired by sw.skipWaiting()
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (url) window.location.replace(url)
    else window.location.reload()
  }, { once: true })
}

export function navigateToRootOnSwClientsClaim () {
  // fired by sw.skipWaiting()
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.pathname = '/'
  }, { once: true })
}
