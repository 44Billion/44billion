import { toSignal } from '#f'
import { tell, reply } from './index.js'
import {
  APP_BRIDGE_ERROR_KIND,
  tagAppBridgeFileError
} from './app-bridge-error.js'
import { nostrDbStreamDonePayload } from './nostrdb-protocol.js'
import {
  createNostrDbMaintenanceSignEvent,
  createNostrDbPersonalCopyDecrypt,
  createNostrDbPersonalCopyEncrypt,
  createNostrDbPersonalCopyObfuscate,
  createNostrDbSignEvent,
  createNostrDbSubscriptionAuthorizer,
  nostrDbMaintenanceOptions,
  nostrDbReadParamsWithAppId,
  runNostrDbMethod
} from './browser/nostrdb.js'
import { appIdToAddressObj, addressObjToAppId } from '#helpers/app.js'
import { base36NsiteToBase16, bytesToBase36Nsite } from 'libp2r2p/base36'
import { base16ToBase62, base62ToBytes } from 'libp2r2p/base62'
import { appEncode, appDecode } from 'libp2r2p/nip19'
import { streamFileChunksFromDb, getFileChunksFromDb, deleteFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import { getNostrDb, startGlobalChunkMaintenance } from '#services/idb/nostrdb/index.js'
import AppFileManager from '#services/app-file-manager/index.js'
import { setWebStorageItem } from '#hooks/use-web-storage.js'
import { Base93Encoder, decode } from 'libp2r2p/base93'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToBase16 } from 'libp2r2p/base16'
import {
  ASSET_BUDGET_BACKGROUND_DENIED,
  ASSET_BUDGET_DENIED_BY_USER
} from '#services/app-asset-budget/index.js'
import { APP_FILE_CHUNK_BYTES } from '#constants/app-file.js'
import { PROGRESS_VISIBLE_AFTER_COMPLETE_MS, stampProgressEntry } from '#helpers/caching-progress.js'
import NFileDownloader from '#services/nfile-downloader/index.js'
import { getEffectiveLocale, subscribeLocaleChanged } from '#i18n/index.js'
import { askNip07 } from './browser/nip07.js'
import {
  registerAppBridgeSignalFactory
} from './app-bridge-registry.js'

registerAppBridgeSignalFactory(toSignal)

export const APP_BRIDGE_READY_TIMEOUT_MS = 5000
export const APP_PAGE_READY_TIMEOUT_MS = 5000
// export const APP_BRIDGE_READY_TIMEOUT_MS = 12000
// export const APP_PAGE_READY_TIMEOUT_MS = 12000
export const APP_PENDING_INDICATOR_DELAY_MS = 800

export function retryAppBridge (state, { isAutomatic = false } = {}) {
  if (isAutomatic) {
    console.warn(
      `[app-bridge] Automatic retry for app ${state.appId} on subdomain ${state.key}`
    )
  }
  state.ready$(false)
  state.error$(null)
  state.retryCount$(state.retryCount$() + 1)
  state.bridgeResetInitialization?.()
  if (!isAutomatic) state.bridgeResetRetry?.()
  state.schedule?.()
}

function isAssetBudgetError (error) {
  return [ASSET_BUDGET_BACKGROUND_DENIED, ASSET_BUDGET_DENIED_BY_USER].includes(error?.code)
}

function withCacheFileTimeout (promise, timeoutMs) {
  let timeoutId
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(Object.assign(new Error('Caching file timed out'), { code: 'CACHE_FILE_TIMEOUT' }))
    }, timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId))
}

async function updateIconStorage (appId, favicon, chunks) {
  try {
    const binaryChunks = chunks.map(chunk => decode(chunk))
    const blob = new Blob(binaryChunks, { type: favicon.contentType })
    const reader = new FileReader()
    const dataUrlPromise = new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
    const dataUrl = await dataUrlPromise
    const icon = { fx: favicon.rootHash, url: dataUrl }
    setWebStorageItem(localStorage, `session_appById_${appId}_icon`, icon)
    return icon
  } catch (error) {
    console.log('Failed to update icon storage:', error)
  }
}

function listenToTrustedAppPageMessages ({
  state,
  appFiles,
  appId,
  userPkB16,
  isDefaultUser,
  cachingProgress$,
  askVault,
  onFileNotCached,
  requestAssetBudgetConfirmation,
  signal
}) {
  return function (trustedAppPagePort) {
    trustedAppPagePort.addEventListener('message', async e => {
      if (state.currentPort !== trustedAppPagePort) return
      switch (e.data.code) {
        case 'STREAM_NFILE': {
          const { entity, method, range, localOnly, requestToken } = e.data.payload || {}
          if (!requestToken || state.nfileDownloads.has(requestToken)) {
            reply(e, { error: new Error('INVALID_NFILE_REQUEST'), isLast: true }, { to: trustedAppPagePort })
            break
          }

          const signEvent = isDefaultUser
            ? null
            : createNostrDbMaintenanceSignEvent({ askVault, pubkey: userPkB16, timeoutMs: 5000 })
          const cacheDb = signEvent
            ? getNostrDb(userPkB16, { ...nostrDbMaintenanceOptions(signEvent) })
            : null
          let downloader
          try {
            downloader = new NFileDownloader(entity, {
              activeOwner: userPkB16,
              cacheEvent: cacheDb
                ? async event => {
                  const result = await cacheDb.add(event, {
                    mergeReplaceable: false,
                    signEvent
                  })
                  if (!result.ok) throw new Error(result.message)
                  return result
                }
                : null,
              signal
            })
            state.nfileDownloads.set(requestToken, downloader)
            const response = await downloader.open({ method, range, localOnly: localOnly === true })
            if (state.nfileDownloads.get(requestToken) !== downloader) break
            reply(e, {
              payload: { status: response.status, headers: response.headers },
              isLast: !response.body
            }, { to: trustedAppPagePort })
            if (response.body) {
              for await (const chunk of response.body) {
                if (state.nfileDownloads.get(requestToken) !== downloader) break
                reply(e, { payload: { chunk }, isLast: false }, { to: trustedAppPagePort })
              }
              if (state.nfileDownloads.get(requestToken) === downloader) {
                reply(e, { payload: { done: true }, isLast: true }, { to: trustedAppPagePort })
              }
            }
          } catch (error) {
            if (state.nfileDownloads.get(requestToken) === downloader) {
              reply(e, { error, isLast: true }, { to: trustedAppPagePort })
            }
          } finally {
            downloader?.close()
            state.nfileDownloads.delete(requestToken)
          }
          break
        }
        case 'CANCEL_NFILE': {
          const downloader = state.nfileDownloads.get(e.data.payload?.requestToken)
          downloader?.close()
          state.nfileDownloads.delete(e.data.payload?.requestToken)
          break
        }
        case 'STREAM_APP_FILE': {
          const handleStreamError = (originalError, errorToSend = new Error('FILE_NOT_CACHED')) => {
            if (originalError) console.log(originalError)
            if (onFileNotCached && errorToSend.message !== 'HTML_FILE_NOT_CACHED' && !isAssetBudgetError(originalError) && !isAssetBudgetError(errorToSend)) {
              onFileNotCached({
                pathname: e.data.payload.pathname,
                kind: APP_BRIDGE_ERROR_KIND.FILE
              })
            }
            return reply(e, {
              error: tagAppBridgeFileError(errorToSend),
              isLast: true
            }, { to: trustedAppPagePort })
          }

          try {
            const cacheStatus = await appFiles.getFileCacheStatus(e.data.payload.pathname, null, { withMeta: true })
            if (!cacheStatus.isCached) {
              if (cacheStatus.isHtml) handleStreamError(null, new Error('HTML_FILE_NOT_CACHED'))
              else {
                let {
                  fileRootHash,
                  total: totalChunks
                } = cacheStatus
                let nextChunkIndexToStream = 0
                let hasErrored = false
                let hasSentLast = false
                let isStreaming = false
                const progressCompletionTimers = new Map()

                const clearProgressCompletionTimer = filename => {
                  const timer = progressCompletionTimers.get(filename)
                  if (timer) {
                    clearTimeout(timer)
                    progressCompletionTimers.delete(filename)
                  }
                }

                const tryStream = async () => {
                  if (hasErrored || hasSentLast || isStreaming) return
                  isStreaming = true
                  try {
                    // eslint-disable-next-line no-unmodified-loop-condition
                    while (!hasErrored && !hasSentLast) {
                      const chunks = await getFileChunksFromDb(appId, fileRootHash, {
                        fromPos: nextChunkIndexToStream,
                        toPos: nextChunkIndexToStream
                      })
                      if (chunks.length === 0) break
                      const chunk = chunks[0]
                      if (totalChunks === null) {
                        const parsedTotal = chunk.total ?? Number(chunk.evt.tags.find(tag => tag[0] === 'mmr')?.[2])
                        if (!Number.isNaN(parsedTotal) && parsedTotal > 0) totalChunks = parsedTotal
                      }
                      const isLast = (totalChunks != null && nextChunkIndexToStream === totalChunks - 1)
                      reply(e, {
                        payload: {
                          content: chunk.evt.content,
                          ...(nextChunkIndexToStream === 0 && { contentType: cacheStatus.contentType })
                        },
                        isLast
                      }, { to: trustedAppPagePort })
                      nextChunkIndexToStream++
                      if (isLast) hasSentLast = true
                    }
                  } catch (err) {
                    hasErrored = true
                    handleStreamError(err)
                  } finally {
                    isStreaming = false
                  }
                }

                const progressCallback = async ({ progress: cachingProgress, chunkIndex, total, error }) => {
                  if (hasErrored || hasSentLast) return
                  const filename = e.data.payload.pathname
                  if (error) {
                    hasErrored = true
                    clearProgressCompletionTimer(filename)
                    const currentProgress = cachingProgress$()
                    const { [filename]: _, ...remaining } = currentProgress
                    cachingProgress$(remaining)
                    return handleStreamError(error)
                  }

                  if (total && totalChunks === null) totalChunks = total
                  const currentProgress = cachingProgress$()
                  cachingProgress$({
                    ...currentProgress,
                    [filename]: stampProgressEntry({
                      progress: cachingProgress,
                      totalByteSizeEstimate: totalChunks ? totalChunks * APP_FILE_CHUNK_BYTES : 0
                    })
                  })
                  if (cachingProgress >= 100) {
                    clearProgressCompletionTimer(filename)
                    const timer = setTimeout(() => {
                      progressCompletionTimers.delete(filename)
                      const latestProgress = cachingProgress$()
                      const { [filename]: _, ...remaining } = latestProgress
                      cachingProgress$(remaining)
                    }, PROGRESS_VISIBLE_AFTER_COMPLETE_MS)
                    progressCompletionTimers.set(filename, timer)
                  }
                  if (typeof chunkIndex === 'number') {
                    if (chunkIndex === nextChunkIndexToStream) await tryStream()
                  } else {
                    await tryStream()
                  }
                }

                try {
                  await tryStream()
                  if (!hasSentLast && !hasErrored) {
                    const cachePromise = appFiles.cacheFile(e.data.payload.pathname, cacheStatus.pathTag, progressCallback, {
                      assetBudget: {
                        mode: 'foreground',
                        requestConfirmation: requestAssetBudgetConfirmation
                      }
                    })
                    return await withCacheFileTimeout(cachePromise, 180000)
                  }
                } catch (err) {
                  return handleStreamError(err)
                }
              }
            }

            let i = 0
            for await (const chunk of streamFileChunksFromDb(appId, appFiles.getFileRootHash(e.data.payload.pathname))) {
              reply(e, {
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
    tell(trustedAppPagePort, { code: 'BROWSER_READY', payload: null })
  }
}

export async function initAppBridge (state, {
  cachingProgress$,
  askVault,
  onFileNotCached,
  requestAssetBudgetConfirmation,
  signal = null
}) {
  startGlobalChunkMaintenance()
  state.bridgeErrorHandler = onFileNotCached
  // state.userPk is the base62 workspace user key; the bridge helpers expect the
  // base36 nsite representation used by the old user-page bridge.
  const userPkB36 = bytesToBase36Nsite(
    base62ToBytes(state.userPk, { mode: 'integer', byteLength: 32 })
  )
  const userPkB16 = base36NsiteToBase16(userPkB36)
  const isDefaultUser = base16ToBase62(
    userPkB16,
    { mode: 'integer', minLength: 43 }
  ) === JSON.parse(localStorage.getItem('session_defaultUserPk'))
  const appAddress = appIdToAddressObj(state.appId)
  let appFilesPromise = AppFileManager.create(state.appId, appAddress)
  state.appFilesPromise = appFilesPromise
  appFilesPromise.catch(() => {})
  const appOrigin = `${location.protocol}//${state.appSubdomain}.${location.host}`

  let cleanupFns = []
  let bridgeTimer
  let autoRetried = false
  state.bridgeRetryState = {
    onError: details => onFileNotCached({
      pathname: typeof details === 'string' ? details : details?.pathname,
      kind: APP_BRIDGE_ERROR_KIND.BRIDGE
    }),
    retry: () => retryAppBridge(state)
  }

  const startTrustedMessages = async (trustedAppPagePort) => {
    let appFiles
    try {
      appFiles = await appFilesPromise
    } catch (error) {
      state.error$(error)
      state.ready$(false)
      clearTimeout(bridgeTimer)
      onFileNotCached({ pathname: undefined, kind: APP_BRIDGE_ERROR_KIND.BRIDGE })
      return
    }
    if (signal?.aborted || state.currentPort !== trustedAppPagePort) return
    state.appFiles = appFiles
    const listen = listenToTrustedAppPageMessages({
      state,
      appFiles,
      appId: state.appId,
      userPkB16,
      isDefaultUser,
      cachingProgress$,
      askVault,
      onFileNotCached: details => onFileNotCached(details),
      requestAssetBudgetConfirmation,
      signal
    })
    listen(trustedAppPagePort)
    state.ready$(true)
    state.error$(null)
    clearTimeout(bridgeTimer)
  }

  const onReadyMessage = e => {
    if (
      e.data.code !== 'TRUSTED_IFRAME_READY' ||
      e.source !== state.trustedIframeRef$()?.contentWindow ||
      e.origin !== appOrigin
    ) return
    state.currentPortAbortController?.abort()
    state.currentPortAbortController = new AbortController()
    state.currentPort?.close()
    state.currentPort = e.ports[0]
    startTrustedMessages(state.currentPort)
  }
  window.addEventListener('message', onReadyMessage, { signal })
  cleanupFns.push(() => window.removeEventListener('message', onReadyMessage))

  const schedule = () => {
    state.ready$(false)
    state.error$(null)
    state.trustedIframeSrc$(
      `//${state.appSubdomain}.${window.location.host}/~~napp?bridgeId=${encodeURIComponent(state.bridgeId)}`
    )
    clearTimeout(bridgeTimer)
    bridgeTimer = setTimeout(() => {
      if (state.ready$()) return
      if (!autoRetried) {
        autoRetried = true
        // One automatic retry. Do not clear autoRetried here: the next timeout
        // must escalate to the file-not-cached dialog instead of retrying forever.
        retryAppBridge(state, { isAutomatic: true })
        return
      }
      console.warn(
        `[app-bridge] Automatic retry did not recover; showing recovery dialog for app ${state.appId} on subdomain ${state.key}`
      )
      state.error$(new Error('App bridge did not become ready'))
      state.bridgeRetryState?.onError({
        pathname: undefined
      })
    }, APP_BRIDGE_READY_TIMEOUT_MS)
  }
  state.bridgeResetRetry = () => { autoRetried = false }
  state.bridgeResetInitialization = () => {
    AppFileManager.invalidateCachedInstance(state.appId)
    appFilesPromise = AppFileManager.create(state.appId, appAddress)
    state.appFilesPromise = appFilesPromise
    state.appFiles = null
    state.currentPortAbortController?.abort()
    state.currentPort?.close()
    state.currentPort = null
  }
  state.schedule = schedule
  schedule()

  const cleanup = () => {
    clearTimeout(bridgeTimer)
    state.currentPortAbortController?.abort()
    state.currentPort?.close()
    state.currentPort = null
    state.ready$(false)
    cleanupFns.forEach(fn => fn())
    cleanupFns = []
  }
  state.bridgeCleanup = cleanup
  return cleanup
}

function getAppMetadata (appIdParam, appAddressParam, {
  appMetadataCache,
  appFetchingState,
  timeoutMs = 1750
} = {}) {
  if (appMetadataCache.has(appIdParam)) return appMetadataCache.get(appIdParam)
  if (!appFetchingState.has(appIdParam)) {
    appFetchingState.set(appIdParam, { icon: false, name: false, promise: null })
  }
  const fetchingState = appFetchingState.get(appIdParam)
  if (fetchingState.promise) return fetchingState.promise

  appAddressParam ??= appIdToAddressObj(appIdParam)
  const metadataPromise = (async () => {
    const targetAppFiles = await AppFileManager.create(appIdParam, appAddressParam)
    const appObject = {
      id: appIdParam,
      napp: appEncode(appAddressParam),
      alias: appAddressParam.dTag || undefined
    }
    const promises = []
    if (!('icon' in appObject) && !fetchingState.icon) {
      fetchingState.icon = true
      promises.push(
        targetAppFiles.getIcon()
          .then(icon => icon && (appObject.icon = icon))
          .finally(() => { fetchingState.icon = false })
      )
    }
    if (!('name' in appObject) && !fetchingState.name) {
      fetchingState.name = true
      promises.push(
        targetAppFiles.getName()
          .then(name => name && (appObject.name = name))
          .finally(() => { fetchingState.name = false })
      )
    }
    if (promises.length > 0) {
      const combinedPromises = Promise.all(promises).then(() => appMetadataCache.set(appIdParam, appObject))
      await Promise.race([combinedPromises, new Promise(resolve => setTimeout(resolve, timeoutMs))])
    }
    appMetadataCache.set(appIdParam, appObject)
    appFetchingState.delete(appIdParam)
    return appObject
  })()
  fetchingState.promise = metadataPromise
  return metadataPromise
}

function cancelNostrDbSubscription (subscriptions, subscriptionId) {
  const subscription = subscriptions.get(subscriptionId)
  if (!subscription) return
  subscription.cancelled = true
  subscription.iterator?.return?.()
}

async function streamNostrDbSubscription (e, {
  db,
  params = [],
  subscriptionId,
  subscriptions,
  appPagePort,
  authorizer,
  appId
}) {
  let subscription
  try {
    if (!subscriptionId) throw new Error('NOSTRDB_SUBSCRIPTION_ID_REQUIRED')
    if (subscriptions.has(subscriptionId)) throw new Error('NOSTRDB_SUBSCRIPTION_EXISTS')
    subscription = { iterator: null, cancelled: false }
    subscriptions.set(subscriptionId, subscription)

    await authorizer?.authorizeBeforeStart?.()
    if (subscription.cancelled) return
    const iterator = db.subscribe(...nostrDbReadParamsWithAppId(params, { appId }))
    subscription.iterator = iterator
    for await (const item of iterator) {
      await authorizer?.authorizeItem?.(item)
      reply(e, { payload: item, isLast: false }, { to: appPagePort })
    }
    if (!subscription.cancelled) {
      reply(e, {
        payload: nostrDbStreamDonePayload(subscriptionId),
        isLast: true
      }, { to: appPagePort })
    }
  } catch (error) {
    if (!subscription?.cancelled) reply(e, { error, isLast: true }, { to: appPagePort })
  } finally {
    if (subscriptions.get(subscriptionId) === subscription) subscriptions.delete(subscriptionId)
  }
}

function createAppPageMessageListener ({
  state,
  appFiles,
  appId,
  appAddress,
  userPkB16,
  isDefaultUser,
  askVault,
  requestPermission,
  openApp,
  onFileNotCached,
  requestAssetBudgetConfirmation,
  signal
}) {
  const appMetadataCache = new Map()
  const appFetchingState = new Map()

  return function (appPagePort) {
    appPagePort.addEventListener('message', async e => {
      switch (e.data.code) {
        case 'OPEN_APP': {
          let targetAppId
          try {
            const { href } = e.data.payload
            const urlObj = new URL(href, self.location.origin)
            const pathname = urlObj.pathname
            const encodedAppPattern = /^\/(\+{1,3}[a-zA-Z0-9]{48,})/
            const match = pathname.match(encodedAppPattern)
            if (!match) {
              console.error('Invalid app URL format:', href)
              break
            }
            const encodedAppId = match[1]
            const targetAppAddress = appDecode(encodedAppId)
            targetAppId = addressObjToAppId(targetAppAddress)
            const targetAppMetadata = await getAppMetadata(targetAppId, targetAppAddress, {
              appMetadataCache,
              appFetchingState,
              timeoutMs: 0
            })
            await requestPermission({
              app: await getAppMetadata(appId, appAddress, { appMetadataCache, appFetchingState, timeoutMs: 0 }),
              name: 'openApp',
              eKind: null,
              meta: { targetApp: targetAppMetadata }
            })
            openApp(href)
          } catch (error) {
            try {
              let isTargetAppInstalled = false
              for (const wsKey of JSON.parse(localStorage.getItem('session_workspaceKeys')) ?? []) {
                const appKeys = JSON.parse(
                  localStorage.getItem(`session_workspaceByKey_${wsKey}_appById_${targetAppId}_appKeys`)
                )
                isTargetAppInstalled = Array.isArray(appKeys) && appKeys.length > 0
                if (isTargetAppInstalled) break
              }
              if (targetAppId && !isTargetAppInstalled) {
                setWebStorageItem(localStorage, `session_appById_${targetAppId}_icon`, undefined)
                setWebStorageItem(localStorage, `session_appById_${targetAppId}_name`, undefined)
                setWebStorageItem(localStorage, `session_appById_${targetAppId}_description`, undefined)
                setWebStorageItem(localStorage, `session_appById_${targetAppId}_relayHints`, undefined)
                const targetAppFiles = await AppFileManager.create(targetAppId)
                await targetAppFiles.clearAppFiles()
              }
            } catch (cleanupError) {
              console.error('Failed to clear rejected target app files:', cleanupError)
            }
            if (error?.message !== 'Permission denied') console.error('Error in OPEN_APP handler:', error)
          }
          break
        }
        case 'NIP07': {
          if (
            ['peek_public_key', 'get_public_key'].includes(e.data.payload.method) &&
            e.data.payload.ns[0] === '' &&
            e.data.payload.ns.length === 1 &&
            !e.data.payload.with_shared_key
          ) {
            reply(e, { payload: userPkB16 }, { to: appPagePort })
            break
          }
          const { ns, with_shared_key: withSharedKey, method, params = [] } = e.data.payload
          const appMetadata = await getAppMetadata(appId, appAddress, { appMetadataCache, appFetchingState, timeoutMs: 0 })
          let msg
          try {
            msg = await askNip07(askVault, userPkB16, { ns, withSharedKey, method, params }, {
              isDefaultUser,
              requestPermission,
              app: appMetadata
            })
          } catch (err) {
            msg = { error: err }
          }
          reply(e, msg, { to: appPagePort })
          break
        }
        case 'NOSTRDB': {
          const { method, params = [], subscriptionId } = e.data.payload || {}
          const maintenanceSignEvent = isDefaultUser
            ? null
            : createNostrDbMaintenanceSignEvent({ askVault, pubkey: userPkB16 })
          const personalCopyDecrypt = isDefaultUser
            ? null
            : createNostrDbPersonalCopyDecrypt({ askVault, pubkey: userPkB16 })
          const personalCopyEncrypt = isDefaultUser
            ? null
            : createNostrDbPersonalCopyEncrypt({ askVault, pubkey: userPkB16 })
          const personalCopyObfuscate = isDefaultUser
            ? null
            : createNostrDbPersonalCopyObfuscate({ askVault, pubkey: userPkB16 })
          const db = getNostrDb(userPkB16, {
            ...nostrDbMaintenanceOptions(maintenanceSignEvent),
            ...(personalCopyDecrypt ? { personalCopyDecrypt } : {}),
            ...(personalCopyObfuscate ? { personalCopyObfuscate } : {})
          })
          const appMetadata = await getAppMetadata(appId, appAddress, { appMetadataCache, appFetchingState, timeoutMs: 0 })
          if (method === 'subscribe') {
            const authorizer = createNostrDbSubscriptionAuthorizer({
              app: appMetadata,
              requestPermission,
              params
            })
            streamNostrDbSubscription(e, {
              db,
              params,
              subscriptionId,
              subscriptions: state.nostrDbSubscriptions,
              appPagePort,
              authorizer,
              appId
            })
            break
          }
          const signEvent = createNostrDbSignEvent({
            askNip07,
            askVault,
            pubkey: userPkB16,
            app: appMetadata,
            isDefaultUser
          })
          try {
            reply(e, {
              payload: await runNostrDbMethod({
                db,
                method,
                params,
                appId,
                signEvent,
                requestPermission,
                app: appMetadata,
                personalCopyEncrypt,
                personalCopyObfuscate
              })
            }, { to: appPagePort })
          } catch (error) {
            reply(e, { error }, { to: appPagePort })
          }
          break
        }
        case 'NOSTRDB_CANCEL': {
          cancelNostrDbSubscription(state.nostrDbSubscriptions, e.data.payload?.subscriptionId)
          break
        }
        case 'WINDOW_NAPP': {
          handleNappRequest(e)
          break
        }
        case 'STREAM_APP_ICON': {
          try {
            const favicon = appFiles.getFaviconMetadata()
            if (!favicon) {
              const icon = await appFiles.getIcon()
              if (!icon?.url) {
                reply(e, { error: new Error('No icon'), isLast: true }, { to: appPagePort })
                break
              }
              const commaIdx = icon.url.indexOf(',')
              const mimeType = icon.url.slice(5, commaIdx).split(';')[0] || null
              const contentType = mimeType || 'application/octet-stream'
              const bytes = Uint8Array.from(atob(icon.url.slice(commaIdx + 1)), c => c.charCodeAt(0))
              const numChunks = Math.max(1, Math.ceil(bytes.length / APP_FILE_CHUNK_BYTES))
              for (let i = 0; i < numChunks; i++) {
                const content = new Base93Encoder().update(bytes.slice(i * APP_FILE_CHUNK_BYTES, (i + 1) * APP_FILE_CHUNK_BYTES)).getEncoded()
                reply(e, {
                  payload: { content, ...(i === 0 && { mimeType, contentType }) },
                  isLast: i === numChunks - 1
                }, { to: appPagePort })
              }
              break
            }

            let cacheStatus = (await appFiles.getFileCacheStatus(null, favicon.tag, { withMeta: true }))
            if (!cacheStatus.isCached) {
              await appFiles.cacheFile(null, favicon.tag, null, {
                assetBudget: {
                  mode: 'foreground',
                  requestConfirmation: requestAssetBudgetConfirmation
                }
              })
              cacheStatus = (await appFiles.getFileCacheStatus(null, favicon.tag, { withMeta: true }))
            }

            if (favicon.service === 'blossom') {
              const hasher = sha256.create()
              for await (const chunk of streamFileChunksFromDb(appId, favicon.rootHash)) {
                hasher.update(decode(chunk.evt.content))
              }
              if (bytesToBase16(hasher.digest()) !== favicon.rootHash) {
                if (favicon.rootHash) await deleteFileChunksFromDb(appId, favicon.rootHash)
                reply(e, { error: new Error('Icon hash mismatch'), isLast: true }, { to: appPagePort })
                break
              }
            }

            const currentlyCachedAppIconFxOnLs = JSON.parse(localStorage.getItem(`session_appById_${appId}_icon`))?.fx
            const shouldCacheIconOnLs = currentlyCachedAppIconFxOnLs !== favicon.rootHash
            const allChunks = []
            let i = 0
            for await (const chunk of streamFileChunksFromDb(appId, favicon.rootHash)) {
              if (shouldCacheIconOnLs) allChunks.push(chunk.evt.content)
              reply(e, {
                payload: {
                  content: chunk.evt.content,
                  ...(i === 0 && {
                    mimeType: favicon.mimeType || cacheStatus.mimeType,
                    contentType: favicon.contentType || cacheStatus.contentType
                  })
                }, isLast: ++i === cacheStatus.total
              }, { to: appPagePort })
            }

            if (allChunks.length > 0) {
              const { url } = await updateIconStorage(appId, favicon, allChunks)
              if (appMetadataCache.has(appId)) {
                const cachedMetadata = appMetadataCache.get(appId)
                cachedMetadata.icon = { fx: favicon.rootHash, url }
              }
            }
          } catch (error) {
            console.log(error.stack)
            reply(e, { error, isLast: true }, { to: appPagePort })
          }
          break
        }
        case 'CACHE_APP_FILE': {
          try {
            const progressCallback = ({ progress, error }) => {
              if (error) {
                if (onFileNotCached && !isAssetBudgetError(error)) {
                  onFileNotCached({
                    pathname: e.data.payload.pathname,
                    kind: APP_BRIDGE_ERROR_KIND.FILE
                  })
                }
                reply(e, {
                  error: tagAppBridgeFileError(error),
                  isLast: true
                }, { to: appPagePort })
              } else {
                reply(e, { payload: progress, isLast: progress >= 100 }, { to: appPagePort })
              }
            }
            appFiles.cacheFile(e.data.payload.pathname, null, progressCallback, {
              assetBudget: {
                mode: 'foreground',
                requestConfirmation: requestAssetBudgetConfirmation
              }
            })
          } catch (error) {
            if (onFileNotCached && !isAssetBudgetError(error)) {
              onFileNotCached({
                pathname: e.data.payload.pathname,
                kind: APP_BRIDGE_ERROR_KIND.FILE
              })
            }
            reply(e, {
              error: tagAppBridgeFileError(error),
              isLast: true
            }, { to: appPagePort })
          }
          break
        }
      }
    }, { signal })
    appPagePort.start()
    tell(appPagePort, {
      code: 'BROWSER_READY',
      payload: {
        locale: getEffectiveLocale(),
        bridgeId: state.bridgeId
      }
    })
    const unsubscribeLocale = subscribeLocaleChanged(locale => {
      tell(appPagePort, { code: 'LOCALE_CHANGED', payload: { locale } })
    })
    signal.addEventListener('abort', unsubscribeLocale, { once: true })
  }
}

function handleNappRequest (e) {
  return reply(e, { error: new Error('Not implemented yet') })
}

export function initAppWindow (state, {
  initialRoute,
  appIframeRef$,
  appIframeSrc$,
  askVault,
  requestPermission,
  openApp,
  onFileNotCached,
  requestAssetBudgetConfirmation,
  onAppReady,
  signal
}) {
  const appAddress = appIdToAddressObj(state.appId)
  const userPkB36 = bytesToBase36Nsite(
    base62ToBytes(state.userPk, { mode: 'integer', byteLength: 32 })
  )
  const userPkB16 = base36NsiteToBase16(userPkB36)
  const isDefaultUser = base16ToBase62(
    userPkB16,
    { mode: 'integer', minLength: 43 }
  ) === JSON.parse(localStorage.getItem('session_defaultUserPk'))
  const appOrigin = `${location.protocol}//${state.appSubdomain}.${location.host}`
  let currentAppPagePort = null
  let ac = null

  const listen = createAppPageMessageListener({
    state,
    appFiles: state.appFiles,
    appId: state.appId,
    appAddress,
    userPkB16,
    isDefaultUser,
    askVault,
    requestPermission,
    openApp,
    onFileNotCached,
    requestAssetBudgetConfirmation,
    signal
  })

  const onAppReadyMessage = e => {
    if (
      e.data.code !== 'APP_IFRAME_READY' ||
      e.source !== appIframeRef$()?.contentWindow ||
      e.origin !== appOrigin
    ) return
    // The `useTask` caller waits for the iframe ref after close/reopen. Check
    // against the current contentWindow rather than a captured frame so a
    // reloaded or recreated iframe cannot send APP_IFRAME_READY to a stale
    // listener.
    ac?.abort()
    ac = new AbortController()
    currentAppPagePort?.close()
    currentAppPagePort = e.ports[0]
    listen(currentAppPagePort)
    onAppReady?.()
  }
  window.addEventListener('message', onAppReadyMessage, { signal })

  const route = `//${state.appSubdomain}.${window.location.host}${initialRoute || ''}`
  appIframeSrc$(route)

  return function cleanup () {
    window.removeEventListener('message', onAppReadyMessage)
    ac?.abort()
    currentAppPagePort?.close()
    currentAppPagePort = null
  }
}
