import { /* handleMessageReply, */ postMessage, replyWithMessage } from '../index.js'
import { appIdToAddressObj } from '#helpers/app.js'
import { base36ToBase16 } from '#helpers/base36.js'
import { base16ToBase62 } from '#helpers/base62.js'
import { appEncode } from '#helpers/nip19.js'
import { streamFileChunksFromDb, getFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import AppFileManager from '#services/app-file-manager/index.js'
import { setWebStorageItem } from '#hooks/use-web-storage.js'
import { decode } from '#services/base93-decoder.js'

// Update icon storage with data URL from streamed chunks
async function updateIconStorage (appId, favicon, chunks) {
  try {
    // Decode base93 content to binary
    const binaryChunks = chunks.map(chunk => decode(chunk))
    const blob = new Blob(binaryChunks, { type: favicon.contentType })

    // Convert to data URL for persistent caching (doesn't get revoked like URL.createObjectURL() does)
    const reader = new FileReader()
    const dataUrlPromise = new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })

    const dataUrl = await dataUrlPromise

    const icon = {
      fx: favicon.rootHash,
      url: dataUrl
    }
    // Update storage using setWebStorageItem to trigger cross-component updates
    setWebStorageItem(localStorage, `session_appById_${appId}_icon`, icon)
    return icon
  } catch (error) {
    console.log('Failed to update icon storage:', error)
  }
}

export async function initMessageListener (
  userPkB36, appId, appSubdomain, initialRoute,
  trustedAppPageIframe, appPageIframe, appPageIframeSrc$,
  cachingProgress$, requestVaultMessage, requestPermission,
  { signal: componentSignal, isSingleNapp = false } = {}
) {
  const userPkB16 = base36ToBase16(userPkB36)
  const isDefaultUser = base16ToBase62(userPkB16) === JSON.parse(localStorage.getItem('session_defaultUserPk'))
  const currentVaultUrl = new URL(JSON.parse(localStorage.getItem('config_vaultUrl')))
  const vaultIframe = document.querySelector(`iframe[src="${currentVaultUrl.href.replace(/\/$/, '')}"]`)
  if (!vaultIframe) console.warn('Vault iframe not found')

  const appAddress = appIdToAddressObj(appId)
  const appFiles = await AppFileManager.create(appId, appAddress)
  if (isSingleNapp) appFiles.updateBundleMetadata({ lastOpenedAsSingleNappAt: Date.now() })

  let currentTrustedAppPagePort = null
  let currentAppPagePort = null
  // Setup cleanup
  componentSignal?.addEventListener('abort', () => {
    if (currentTrustedAppPagePort) {
      currentTrustedAppPagePort.close()
      currentTrustedAppPagePort = null
    }
    if (currentAppPagePort) {
      currentAppPagePort.close()
      currentAppPagePort = null
    }
  }, { once: true })

  let ac
  const appOrigin = location.origin.replace('//', `//${appSubdomain}.`)
  window.addEventListener('message', e => {
    if (
      e.data.code !== 'TRUSTED_IFRAME_READY' ||
      e.source !== trustedAppPageIframe.contentWindow ||
      e.origin !== appOrigin
    ) return

    // iframe's page may reload on sw controller change (and send a new 'TRUSTED_IFRAME_READY' msg)
    ac?.abort()
    ac = new AbortController()
    if (currentTrustedAppPagePort) currentTrustedAppPagePort.close()
    currentTrustedAppPagePort = e.ports[0]
    listenToTrustedAppPageMessages(currentTrustedAppPagePort, AbortSignal.any([componentSignal, ac.signal]))
    loadAppOnce(appSubdomain, initialRoute)
  }, { signal: componentSignal })

  let hasRunLoadApp = false
  function loadAppOnce (appSubdomain, route = '') {
    if (hasRunLoadApp) return

    hasRunLoadApp = true
    let ac
    window.addEventListener('message', e => {
      if (
        e.data.code !== 'APP_IFRAME_READY' ||
        e.source !== appPageIframe.contentWindow ||
        e.origin !== appOrigin
      ) return

      // iframe's page may reload on sw controller change (and send a new 'APP_IFRAME_READY' msg)
      ac?.abort()
      ac = new AbortController()
      if (currentAppPagePort) currentAppPagePort.close()
      currentAppPagePort = e.ports[0]
      listenToAppPageMessages(currentAppPagePort, AbortSignal.any([componentSignal, ac.signal]))
    }, { signal: componentSignal })

    const domain = window.location.host
    // Load real app page beside the already loaded trusted app page iframe
    //
    // Note: for transparent bg, the iframe's html should add
    // <meta name="color-scheme" content="light dark"> to the head tag
    appPageIframeSrc$(`//${appSubdomain}.${domain}${route}`)
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
          const handleStreamError = (originalError, errorToSend = new Error('FILE_NOT_CACHED')) => {
            if (originalError) console.log(originalError)
            return replyWithMessage(e, { error: errorToSend, isLast: true }, { to: trustedAppPagePort })
          }

          try {
            // if chunk is missing (chunks aren't cached), send error,
            // signaling sw should respond with app loader html, if it's .html file,
            // which asks to cache it then reloads,
            // or, when not html,
            // stream as chunks get cached (could also be:
            // defer response and sw itself asks to cache it then after done responds,
            // but there would have a greater chance of the browser putting
            // the sw to sleep compared to when sw is in the middle of a response streaming)
            const cacheStatus = await appFiles.getFileCacheStatus(e.data.payload.pathname, null, { withMeta: true })
            if (!cacheStatus.isCached) {
              if (cacheStatus.isHtml) handleStreamError(null, new Error('HTML_FILE_NOT_CACHED'))
              else {
                let {
                  fileRootHash,
                  total: totalChunks // null when no chunks are cached
                } = cacheStatus
                let nextChunkIndexToStream = 0
                let highestCachedIndex = -1
                let hasErrored = false
                let hasSentLast = false

                const progressCallback = async ({ progress: cachingProgress, newlyCachedChunkIndexRanges, error }) => {
                  if (hasErrored || hasSentLast) return
                  if (error) {
                    hasErrored = true
                    // Clear progress for this file
                    const currentProgress = cachingProgress$()
                    const { [e.data.payload.pathname]: _, ...remaining } = currentProgress
                    cachingProgress$(remaining)
                    return handleStreamError(error)
                  }

                  // Update caching progress in the signal
                  const filename = e.data.payload.pathname
                  const currentProgress = cachingProgress$()
                  cachingProgress$({
                    ...currentProgress,
                    [filename]: {
                      progress: cachingProgress,
                      totalByteSizeEstimate: totalChunks ? (totalChunks - 1) * 51000 : 0
                    }
                  })

                  // Remove from progress when completed
                  if (cachingProgress >= 100) {
                    setTimeout(() => {
                      const latestProgress = cachingProgress$()
                      const { [filename]: _, ...remaining } = latestProgress
                      cachingProgress$(remaining)
                    }, 1000) // Keep visible for 1 second after completion
                  }

                  if (newlyCachedChunkIndexRanges.length > 0) {
                    for (const range of newlyCachedChunkIndexRanges) {
                      highestCachedIndex = Math.max(highestCachedIndex, range[1])
                    }
                  } else if (totalChunks !== null) {
                    highestCachedIndex = totalChunks - 1
                  } else return handleStreamError(new Error('No cached chunks'))

                  while (nextChunkIndexToStream <= highestCachedIndex && !hasErrored && !hasSentLast) {
                    try {
                      const chunks = await getFileChunksFromDb(appId, fileRootHash, {
                        fromPos: nextChunkIndexToStream,
                        toPos: nextChunkIndexToStream
                      })

                      if (chunks.length === 0) {
                        hasErrored = true
                        return handleStreamError(new Error(`Missing chunk at index ${nextChunkIndexToStream} for rootHash ${fileRootHash}`))
                      }

                      const chunk = chunks[0]
                      if (totalChunks === null) {
                        const cTag = chunk.evt.tags.find(t => t[0] === 'c' && t[1].startsWith(`${fileRootHash}:`))
                        const parsedTotal = parseInt(cTag?.[2])
                        if (!Number.isNaN(parsedTotal) && parsedTotal > 0) totalChunks = parsedTotal
                      }
                      if (totalChunks === null) {
                        hasErrored = true
                        return handleStreamError(new Error('Unable to determine total chunks.'))
                      }

                      const isLast = (totalChunks != null && nextChunkIndexToStream === totalChunks - 1)
                      replyWithMessage(e, {
                        payload: {
                          content: chunk.evt.content,
                          ...(nextChunkIndexToStream === 0 && { contentType: cacheStatus.contentType })
                        },
                        isLast
                      }, { to: trustedAppPagePort })

                      nextChunkIndexToStream++
                      if (isLast) hasSentLast = true
                    } catch (streamError) {
                      hasErrored = true
                      return handleStreamError(streamError)
                    }
                  }
                }

                try {
                  return appFiles.cacheFile(e.data.payload.pathname, cacheStatus.fileTag, progressCallback)
                } catch (err) {
                  return handleStreamError(err)
                }
              }
            }

            let i = 0
            for await (const chunk of streamFileChunksFromDb(appId, appFiles.getFileRootHash(e.data.payload.pathname))) {
              replyWithMessage(e, {
                payload: {
                  content: chunk.evt.content,
                  ...(i === 0 && { contentType: cacheStatus.contentType })
                }, isLast: ++i === cacheStatus.total
              }, { to: trustedAppPagePort })
            }
          } catch (error) { return handleStreamError(error, error) }
          break
        }
      }
    }, { signal })
    trustedAppPagePort.start()
    postMessage(trustedAppPagePort, { code: 'BROWSER_READY', payload: null })
  }

  let nip07AppObject
  function listenToAppPageMessages (appPagePort, signal) {
    appPagePort.addEventListener('message', async e => {
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
          const { ns, method, params = [] } = e.data.payload
          nip07AppObject ??= {
            id: appId,
            napp: appEncode(appAddress) // no relay hint allowed
            // alias: +[+][+]abc@44billion.net, i.e. from +<appIdAlias>[@<domain>]
            // name: from bundleMetadata event
          }
          if (!nip07AppObject.icon) {
            const icon = JSON.parse(localStorage.getItem(`session_appById_${appId}_icon`))
            if (icon) nip07AppObject.icon = icon
          }
          let msg
          try {
            msg = await requestNip07Message(
              requestVaultMessage, userPkB16, ns, method, params,
              { isDefaultUser, requestPermission, app: nip07AppObject }
            )
          } catch (err) {
            msg = { error: err }
          }
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
            if (!favicon) {
              replyWithMessage(e, { error: new Error('No favicon'), isLast: true }, { to: appPagePort })
              break
            }

            let cacheStatus = (await appFiles.getFileCacheStatus(null, favicon.tag, { withMeta: true }))
            if (!cacheStatus.isCached) {
              await appFiles.cacheFile(null, favicon.tag)
              cacheStatus = (await appFiles.getFileCacheStatus(null, favicon.tag, { withMeta: true }))
            }
            const currentlyCachedAppIconFxOnLs = JSON.parse(localStorage.getItem(`session_appById_${appId}_icon`))?.fx
            const shouldCacheIconOnLs = currentlyCachedAppIconFxOnLs !== favicon.rootHash

            // Collect chunks for storage update
            const allChunks = []
            let i = 0
            for await (const chunk of streamFileChunksFromDb(appId, favicon.rootHash)) {
              if (shouldCacheIconOnLs) allChunks.push(chunk.evt.content)
              replyWithMessage(e, {
                payload: {
                  content: chunk.evt.content,
                  ...(i === 0 && {
                    mimeType: favicon.mimeType || cacheStatus.mimeType,
                    contentType: favicon.contentType || cacheStatus.contentType
                  })
                }, isLast: ++i === cacheStatus.total
              }, { to: appPagePort })
            }

            // Update icon storage with complete data
            if (allChunks.length > 0) {
              const { url } = await updateIconStorage(appId, favicon, allChunks)
              if (nip07AppObject) nip07AppObject.icon = { fx: favicon.rootHash, url }
            }
          } catch (error) {
            console.log(error.stack)
            replyWithMessage(e, { error, isLast: true }, { to: appPagePort })
          }
          break
        }
        case 'CACHE_APP_FILE': {
          try {
            const progressCallback = ({ progress, error }) => {
              if (error) {
                replyWithMessage(e, { error, isLast: true }, { to: appPagePort })
              } else {
                const isLast = progress >= 100
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
    postMessage(appPagePort, { code: 'BROWSER_READY', payload: null })
  }
}

function handleNappRequest (e) {
  return replyWithMessage(e, { error: new Error('Not implemented yet') })
}

const methodNameToPermissionName = {
  getPublicKey: 'readProfile',
  signEvent: 'signEvent',
  nip04Encrypt: 'encrypt',
  nip04Decrypt: 'decrypt',
  nip44Encrypt: 'encrypt',
  nip44Decrypt: 'decrypt'
}
function toPermissionName (method) {
  return methodNameToPermissionName[method] ||
    (() => { throw new Error(`Unknown method ${method}`) })()
}
export async function requestNip07Message (
  requestVaultMessage, pubkey, ns, method, params, { isDefaultUser, requestPermission, app } = {}
) {
  if (isDefaultUser) throw new Error('Please login')
  if (requestPermission) {
    const camelCaseMethod = method.includes('_')
      ? method.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
      : method
    // TODO: find out the kind by decrypting first
    const eKind = (() => {
      switch (camelCaseMethod) {
        case 'signEvent': return params?.[0]?.kind
        // default: return -1 // all kinds
        default: return null // won't grant to all kinds
      }
    })()

    await requestPermission({
      app,
      name: toPermissionName(camelCaseMethod),
      eKind
    })
  }

  const { napp, ...appRest } = app
  const msg = {
    code: 'NIP07',
    payload: {
      app: {
        ...appRest,
        id: napp // for vault, this is the id
      },
      pubkey,
      ns, // [name, ...optionalArgs]
      method,
      params
    }
  }
  return requestVaultMessage(msg, { timeout: 120000 })
}
