import { clearAppData, initMessageListener, tellParentImReady } from '#helpers/window-message/trusted-app-page/index.js'

if (window.location.hash === '#clear') {
  clearAppData()
} else {
  initMessageListener()
  tellParentImReady()
}
