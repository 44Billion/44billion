export function checkForSwUpdatesFrequently () {
  // check for sw updates besides the browser auto checks
  setInterval(() => registration.update(), 60 * 60 * 1000)
}

export function triggerReloadOnSwSkipWaiting () {
  // fired by sw.skipWaiting()
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload()
  }, { once: true })
}
