import { clearAppData, prepareAppSession, initMessageListener, tellParentImReady, tellSwImReady } from '#helpers/window-message/trusted-app-page/index.js'

const params = new URL(window.location.href).searchParams
if (window.location.hash === '#clear') {
  clearAppData({ requestId: params.get('clearRequest'), strict: params.get('strictClear') === '1' })
} else {
  prepareAppSession(window.sessionStorage, params.get('assignment'))
  initMessageListener()
  tellParentImReady()
  tellSwImReady().catch(error => {
    console.warn('[trusted-app-page] Initial service worker registration failed', error)
  })
}
