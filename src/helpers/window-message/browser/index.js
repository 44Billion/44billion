import { getUserPageOrigin, handleMessageReply, requestMessage, replyWithMessage } from '../index.js'
import { appIdToAddressObj } from '#helpers/app.js'
import { streamFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import AppFileManager from '#services/app-file-manager/index.js'
const currentVaultUrl = new URL(JSON.parse(localStorage.getItem('config_vaultUrl')))
const vaultIframe = document.querySelector(`iframe[src="${currentVaultUrl.href}"]`)
if (!vaultIframe) console.log('TODO: add vault') // throw new Error('Vault iframe not found')
const vault = vaultIframe?.contentWindow
// const vault = vaultIframe.contentWindow

// Note: wildcard certificates for second-level subdomains are hard to get (*.<many>.a.com),
// that's why the user page exists instead of unifying it with the app page
// like <userpubkey>.<appid>.44billion.net
export async function initMessageListener (userPk, appId) {
  const userPageOrigin = getUserPageOrigin(userPk)
  const appAddress = appIdToAddressObj(appId)
  const appFiles = await AppFileManager.create(appId, appAddress)

  // TODO: problem: this will end-up receiving msgs from same user page but other app page!
  window.addEventListener('message', async e => {
    if (e.data.code === 'REPLY') {
      // vault url may change during app use
      const vaultOrigin = new URL(JSON.parse(localStorage.getItem('config_vaultUrl'))).origin
      if (e.origin !== vaultOrigin) return
      return handleMessageReply(e)
    }
    // if (e.origin !== userPageOrigin) return

    switch (e.data.code) {
      // For now, sw doesn't need this info
      // case 'GET_BUNDLE': {
      //   // using e.data.domainLabels gotten from app sw's self.location
      //   const msg = await getAppBundleMessage(e.data.domainLabels[0])
      //   replyWithMessage(e, msg)
      //   break
      // }
      case 'STREAM_APP_ICON': {
        try {
          // almost same as below but
          // first find out favicon.??? that is image extension or of image/... mime-type
          // and if not cached, cache it completly only then stream chunks
          const favicon = appFiles.getFaviconMetadata()
          if (!favicon) replyWithMessage(e, { error: new Error('No favicon'), isLast: true })

          const { isCached } = (await appFiles.getFileCacheStatus(null, favicon.tag))
          // eslint-disable-next-line no-empty
          if (!isCached) for await (const _ of appFiles.cacheFile(null, favicon.tag)) {}
        } catch (error) { replyWithMessage(e, { error, isLast: true }) }
        break
      }
      case 'STREAM_APP_FILE': {
        console.log('pediram STREAM_APP_FILE')
        try {
          // if chunk is missing (chunks aren't cached), send error,
          // signaling sw should respond with app loader html, if it's .html file,
          // which asks to cache it then reloads,
          // or defer response and sw itself asks to cache it then after done responds
          const cacheStatus = await appFiles.getFileCacheStatus(e.data.payload.pathname, null, { withMeta: true })
          if (!cacheStatus.isCached) return replyWithMessage(e, { error: new Error('File not cached yet'), isLast: true })

          let i = 0
          for await (const chunk of streamFileChunksFromDb(appId, appFiles.getFileRootHash(e.data.payload.pathname))) {
            replyWithMessage(e, {
              payload: {
                content: chunk.evt.content,
                ...(i === 0 && { contentType: cacheStatus.contentType })
              }, isLast: ++i === cacheStatus.total
            })
          }
        } catch (error) { replyWithMessage(e, { error, isLast: true }) }
        break
      }
      case 'CACHE_APP_FILE': {
        try {
          const iterator = appFiles.cacheFile(e.data.payload.pathname)
          if (iterator.progress) {
            const isLast = iterator.progress >= 100
            replyWithMessage(e, { payload: iterator.progress, isLast })
            if (isLast) return
          }
          for await (const progress of iterator) {
            replyWithMessage(e, { payload: progress, isLast: progress >= 100 })
          }
        } catch (error) { replyWithMessage(e, { error, isLast: true }) }
        break
      }
      case 'NIP07': {
        const { ns, nsParams = [], method, params = [] } = e.data.payload
        const appName = appId
        const msg = await requestNip07Message(userPk, ns, nsParams, method, params, { appName })
        replyWithMessage(e, msg)
        break
      }
    }
  })
}

export async function requestNip07Message (pubkey, ns, nsParams, method, params, { appName } = {}) {
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
  return requestMessage(vault, msg, { timeout: 5000 })
}
