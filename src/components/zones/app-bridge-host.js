import { f, useComputed, useSignal, useTask } from '#f'
import { initAppBridge, retryAppBridge } from '#helpers/window-message/app-bridge.js'
import {
  ensureAppBridgeState,
  getAppBridgeSpecs
} from '#helpers/window-message/app-bridge-registry.js'
import { useFileNotCachedDialogStore, getFileNotCachedText } from '#zones/file-not-cached-dialog/index.js'
import { useConfirmationDialogStore } from '#zones/confirmation-dialog/index.js'
import { getAssetBudgetConfirmation } from '#i18n/asset-budget.js'
import { formatAssetBudgetBytes } from '#services/app-asset-budget/index.js'
import { useVaultActor } from '#zones/vault-modal/index.js'
import { isOnline } from '#helpers/network.js'
import {
  isAppBridgeCommunicationError,
  isCriticalAppFile,
  normalizeAppBridgeError
} from '#helpers/window-message/app-bridge-error.js'

f('app-bridge-host', function () {
  const specs$ = useSignal([])
  useTask(({ track }) => {
    const specs = track(() => getAppBridgeSpecs()())
    specs$(specs)
  })
  const specs = specs$()
  return this.h`
    <div id='app-bridge-host'>
      <style>${/* css */`
        #app-bridge-host {
          position: absolute;
          inset: 0;
          pointer-events: none;
          visibility: hidden;
          overflow: hidden;
          z-index: -1;

          iframe {
            width: 100%;
            height: 100%;
            border: 0;
            margin: 0;
          }
        }
      `}</style>
      <div style='display: contents'></div>
      ${specs.map(spec => this.h({ key: spec.bridgeId })`
        <app-bridge-manager props=${{ appSubdomain: spec.appSubdomain, userPk: spec.userPk, appId: spec.appId, bridgeId: spec.bridgeId }} />
      `)}
    </div>
  `
})

f('app-bridge-manager', function () {
  const appSubdomain = this.props.appSubdomain
  const userPk = this.props.userPk
  const appId = this.props.appId
  const bridgeId = this.props.bridgeId
  const { askVault } = useVaultActor()
  const { requestConfirmation } = useConfirmationDialogStore()
  const { requestAction: requestFileNotCachedAction } = useFileNotCachedDialogStore()

  // The registry can dispose and recreate a bridge state (same subdomain key)
  // while this manager stays mounted, and a keyed list may reuse this instance
  // after the host briefly rendered without it. Derive the current state from
  // the specs signal so both the template and the bridge init follow it.
  const state$ = useComputed(() => {
    const spec = getAppBridgeSpecs()().find(item => item.appSubdomain === appSubdomain)
    return spec ? ensureAppBridgeState(appSubdomain, { userPk, appId }) : null
  })
  const state = state$()

  useTask(async ({ track, cleanup }) => {
    const currentBridgeId = track(() => state$()?.bridgeId ?? null)
    if (!currentBridgeId || currentBridgeId !== bridgeId) return
    const currentState = ensureAppBridgeState(appSubdomain, { userPk, appId })
    const ac = new AbortController()
    cleanup(() => ac.abort())
    const cleanupBridge = await initAppBridge(currentState, {
      signal: ac.signal,
      cachingProgress$: currentState.cachingProgress$,
      askVault,
      requestPermission: () => {},
      onFileNotCached: details => {
        const payload = normalizeAppBridgeError(details)
        const pathname = payload.pathname
        const isCommunication = isAppBridgeCommunicationError(payload)
        const isCritical = !isCommunication && isCriticalAppFile(pathname)
        const message = typeof payload.message === 'string'
          ? payload.message
          : (isCritical && !isCommunication
              ? getFileNotCachedText('Failed to load app. Retry or remove it?')
              : getFileNotCachedText('Failed to load app. Retry or close it?'))
        const onlinePromise = isCritical
          ? isOnline().catch(() => false)
          : Promise.resolve(false)
        const storedNameRaw = localStorage.getItem(`session_appById_${currentState.appId}_name`)
        let storedAppName = ''
        if (storedNameRaw) {
          try {
            storedAppName = JSON.parse(storedNameRaw) ?? ''
          } catch {
            storedAppName = ''
          }
        }
        return requestFileNotCachedAction({
          appName: payload.appName || storedAppName || getFileNotCachedText('App Download'),
          message
        }).then(() => retryAppBridge(currentState)).catch(async () => {
          const online = await onlinePromise
          for (const entry of Array.from(currentState.windows.values())) {
            try {
              if (online && isCritical) {
                const action = entry.onRemove?.() ?? entry.onClose?.()
                await action
              } else {
                await entry.onClose?.()
              }
            } catch (error) {
              console.error('Failed to close or remove app window after file error', error)
            }
          }
        })
      },
      requestAssetBudgetConfirmation: details => requestConfirmation(getAssetBudgetConfirmation({
        ...details,
        formatBytes: formatAssetBudgetBytes
      }))
    })
    cleanup(() => cleanupBridge?.())
  }, { after: 'rendering' })

  if (!state || state.bridgeId !== bridgeId) return undefined

  return this.h`
    <iframe
      ref=${state.trustedIframeRef$}
      src=${state.trustedIframeSrc$()}
      tabindex='-1'
      aria-hidden='true'
    />
  `
})
