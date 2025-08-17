// This page is on the middle between browser and app (also trusted page at /~~napp)
// just to leverage storage partitioning so that
// app storage will always be scoped to a single user,
// simplifying app dev
import { browserOrigin, getAppOrigin, replyWithMessage, postMessage } from '../index.js'
import { userSubdomainToPk } from '#helpers/app.js'

const userSubdomain = location.hostname.split('.')[0]
const userPk = userSubdomainToPk(userSubdomain)

export function initMessageListener (appSubdomain, trustedAppPageIframe) {
  const appOrigin = getAppOrigin(appSubdomain)

  let hasLoadedAppPageIframe = false
  window.addEventListener('message', async e => {
    if ([browserOrigin, appOrigin].includes(e.origin)) return

    switch (e.data.code) {
      case 'REPLY': {
        // forward down
        if (e.origin !== browserOrigin) return
        postMessage(trustedAppPageIframe, e.data, { targetOrigin: appOrigin })
        break
      }
      case 'TRUSTED_IFRAME_READY': {
        if (hasLoadedAppPageIframe || e.origin !== appOrigin) return

        // load real app page beside the trusted app page
        const domain = window.location.host.replace(/^[^.]+\./, '')
        const iframe = document.createElement('iframe')
        iframe.src = `//${appSubdomain}.${domain}`
        document.body.appendChild(iframe)
        hasLoadedAppPageIframe = true
        break
      }
      // window.napp extras
      case 'WINDOW_NAPP': {
        handleNappRequest(e)
        break
      }
      case 'NIP07': {
        if (
          ['peekPublicKey', 'getPublicKey'].includes(e.data.payload.method) &&
          e.data.payload.ns[0] === '' &&
          e.data.payload.ns.length === 1
        ) {
          const msg = { payload: userPk }
          replyWithMessage(e, msg)
          break // other methods will use the default case (handled by the browser)
        }
      }
      // eslint-disable-next-line no-fallthrough
      default: {
        // forward up
        if (e.origin !== appOrigin) return
        postMessage(window.parent, e.data, { targetOrigin: browserOrigin })
      }
    }
  })
}

function handleNappRequest (e) {
  return replyWithMessage(e, { error: new Error('Not implemented yet') })
}
