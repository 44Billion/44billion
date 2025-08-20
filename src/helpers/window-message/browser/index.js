import { handleMessageReply, requestMessage, replyWithMessage } from '../index.js'
import { appIdToAddressObj } from '#helpers/app.js'
import { base36ToBase16 } from '#helpers/base36.js'
import { streamFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import AppFileManager from '#services/app-file-manager/index.js'

export async function initMessageListener (userPkB36, appId, appSubdomain, trustedAppPageIframe, componentSignal) {
  const userPkB16 = base36ToBase16(userPkB36)
  const currentVaultUrl = new URL(JSON.parse(localStorage.getItem('config_vaultUrl')))
  const vaultIframe = document.querySelector(`iframe[src="${currentVaultUrl.href}"]`)
  if (!vaultIframe) console.log('TODO: add vault') // throw new Error('Vault iframe not found')
  const vault = vaultIframe?.contentWindow
  // const vault = vaultIframe.contentWindow

  const appAddress = appIdToAddressObj(appId)
  const appFiles = await AppFileManager.create(appId, appAddress)

  // window.addEventListener('message', async e => {
  //   console.log('MSG received', e.data.code)
  //   // from vault; but just having correct reqId is enough to be sure
  //   if (e.data.code !== 'REPLY') return
  //   // vault url may change during app use
  //   // const vaultOrigin = new URL(JSON.parse(localStorage.getItem('config_vaultUrl'))).origin
  //   // if (e.origin !== vaultOrigin) return

  //   return handleMessageReply(e)
  // }, { signal: componentSignal })

  let ac
  const appOrigin = location.origin.replace('//', `//${appSubdomain}.`)
  window.addEventListener('message', e => {
    if (
      e.data.code !== 'TRUSTED_IFRAME_READY' ||
      e.source !== trustedAppPageIframe.contentWindow ||
      e.origin !== appOrigin
    ) return

    ac?.abort()
    ac = new AbortController()
    // iframe's page may reload on sw controller change
    // listenToTrustedAppPageMessages(trustedAppPagePort, AbortSignal.any([componentSignal, ac.signal]))
    listenToTrustedAppPageMessages(e.ports[0], AbortSignal.any([componentSignal, ac.signal]))

    // replyWithMessage(e, { payload: null }, { transfer: [browserPortForTrusted] })

    loadAppOnce(appSubdomain)
  }, { signal: componentSignal })

  let hasRunLoadApp = false
  function loadAppOnce (appSubdomain) {
    if (hasRunLoadApp) return

    // load real app page beside the already loaded trusted app page iframe
    const domain = window.location.host
    const appPageIframe = document.createElement('iframe')
    appPageIframe.src = `//${appSubdomain}.${domain}`
    appPageIframe.allowtransparency = true
    trustedAppPageIframe.insertAdjacentElement('beforebegin', appPageIframe)
    hasRunLoadApp = true

    let ac
    window.addEventListener('message', e => {
      if (
        e.data.code !== 'APP_IFRAME_READY' ||
        e.source !== appPageIframe.contentWindow ||
        e.origin !== appOrigin
      ) return

      ac?.abort()
      ac = new AbortController()
      // iframe's page may reload on sw controller change
      listenToAppPageMessages(e.ports[0], AbortSignal.any([componentSignal, ac.signal]))
      loadAppOnce(appSubdomain)
    }, { signal: componentSignal })
  }

  function listenToTrustedAppPageMessages (trustedAppPagePort, signal) {
    trustedAppPagePort.addEventListener('message', async e => {
      switch (e.data.code) {
        // For now, sw doesn't need this info
        // case 'GET_BUNDLE': {
        //   // using e.data.domainLabels gotten from app sw's self.location
        //   const msg = await getAppBundleMessage(e.data.domainLabels[0])
        //   replyWithMessage(e, msg, { to: trustedAppPagePort })
        //   break
        // }

        case 'STREAM_APP_FILE': {
          try {
            // if chunk is missing (chunks aren't cached), send error,
            // signaling sw should respond with app loader html, if it's .html file,
            // which asks to cache it then reloads,
            // or defer response and sw itself asks to cache it then after done responds
            const cacheStatus = await appFiles.getFileCacheStatus(e.data.payload.pathname, null, { withMeta: true })
            if (!cacheStatus.isCached) return replyWithMessage(e, { error: new Error('FILE_NOT_CACHED'), isLast: true }, { to: trustedAppPagePort })

            let i = 0
            for await (const chunk of streamFileChunksFromDb(appId, appFiles.getFileRootHash(e.data.payload.pathname))) {
              replyWithMessage(e, {
                payload: {
                  content: chunk.evt.content,
                  ...(i === 0 && { contentType: cacheStatus.contentType })
                }, isLast: ++i === cacheStatus.total
              }, { to: trustedAppPagePort })
            }
          } catch (error) { replyWithMessage(e, { error, isLast: true }) }
          break
        }
      }
    }, { signal })
    trustedAppPagePort.start()
  }

  function listenToAppPageMessages (appPagePort, signal) {
    appPagePort.addEventListener('message', async e => {
      console.log('appPagePort msg received', e.data)
      switch (e.data.code) {
        case 'NIP07': {
          if (
            ['peek_public_key', 'get_public_key'].includes(e.data.payload.method) &&
            e.data.payload.ns[0] === '' &&
            e.data.payload.ns.length === 1
          ) {
            const msg = { payload: userPkB16 }
            replyWithMessage(e, msg, { to: appPagePort })
            break
          }
          // const { ns, nsParams = [], method, params = [] } = e.data.payload
          // const appName = appId
          // const msg = await requestNip07Message(vault, userPkB16, ns, nsParams, method, params, { appName })
          const msg = { error: new Error('Not implemented yet') }
          replyWithMessage(e, msg, { to: appPagePort })
          break
        }
        // window.napp extras
        case 'WINDOW_NAPP': {
          handleNappRequest(e)
          break
        }
        case 'STREAM_APP_ICON': {
          try {
            // almost same as STREAM_APP_FILE but
            // first find a favicon.??? that has image extension or is of image/... mime-type
            // and if not cached, cache it completly, only then stream chunks
            const favicon = appFiles.getFaviconMetadata()
            if (!favicon) replyWithMessage(e, { error: new Error('No favicon'), isLast: true }, { to: appPagePort })

            const cacheStatus = (await appFiles.getFileCacheStatus(null, favicon.tag))
            // eslint-disable-next-line no-empty
            if (!cacheStatus.isCached) for await (const _ of appFiles.cacheFile(null, favicon.tag)) {}

            let i = 0
            for await (const chunk of streamFileChunksFromDb(appId, favicon.rootHash)) {
              replyWithMessage(e, {
                payload: {
                  content: chunk.evt.content,
                  ...(i === 0 && { contentType: favicon.contentType || cacheStatus.contentType })
                }, isLast: ++i === cacheStatus.total
              }, { to: appPagePort })
            }
          } catch (error) { replyWithMessage(e, { error, isLast: true }, { to: appPagePort }) }
          break
        }
        case 'CACHE_APP_FILE': {
          try {
            const progressCallback = ({ progress, error }) => {
              if (error) {
                replyWithMessage(e, { error, isLast: true }, { to: appPagePort })
              } else {
                const isLast = progress >= 100
                console.log(e.data.payload.pathname, 'progress:', progress, 'isLast:', isLast, JSON.stringify(e.data))
                replyWithMessage(e, { payload: progress, isLast }, { to: appPagePort })
              }
            }
            appFiles.cacheFile(e.data.payload.pathname, null, progressCallback)
          } catch (error) {
            console.log(e.data.payload.pathname, 'error:', error.stack)
            replyWithMessage(e, { error, isLast: true }, { to: appPagePort })
          }
          break
        }
      }
    }, { signal })
    appPagePort.start()
  }
}

function handleNappRequest (e) {
  return replyWithMessage(e, { error: new Error('Not implemented yet') })
}

// Maybe will need to send port too on the first time
export async function requestNip07Message (vault, pubkey, ns, nsParams, method, params, { appName } = {}) {
  const msg = {
    code: 'NIP07',
    payload: {
      pubkey,
      ns, // [name, ...optionalArgs]
      method,
      params,
      appName
    }
  }
  return requestMessage(vault, msg, { timeout: 120000 })
}
