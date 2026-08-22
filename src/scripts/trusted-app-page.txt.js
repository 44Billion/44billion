import { clearAppData, initMessageListener, tellParentImReady, tellSwImReady } from '#helpers/window-message/trusted-app-page/index.js'

if (window.location.hash === '#clear') {
  clearAppData()
} else {
  initMessageListener()
  tellParentImReady()
  tellSwImReady().catch(error => {
    console.warn('[trusted-app-page] Initial service worker registration failed', error)
  })
}
