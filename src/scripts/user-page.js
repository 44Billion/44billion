import { initMessageListener } from '#helpers/window-message/user-page/index.js'

const appId = window.location.pathname.slice(1)
const trustedAppPageIframe = document.createElement('iframe')

function loadTrustedAppPage () {
  const domain = window.location.host.replace(/^[^.]+\./, '')
  const pathname = '/~~napp'
  const trustedAppPageIframe = document.createElement('iframe')
  trustedAppPageIframe.src = `//${appId}.${domain}${pathname}`
  document.body.appendChild(trustedAppPageIframe)
}

// this loads real app page after below is ready
initMessageListener(appId, trustedAppPageIframe)
loadTrustedAppPage()
