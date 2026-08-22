import { f, useSignal, useTask } from '#f'
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
      ${specs.map(spec => this.h({ key: spec.key })`
        <app-bridge-manager props=${{ appSubdomain: spec.appSubdomain, userPk: spec.userPk, appId: spec.appId }} />
      `)}
    </div>
  `
})

f('app-bridge-manager', function () {
  const state = ensureAppBridgeState(this.props.appSubdomain, {
    userPk: this.props.userPk,
    appId: this.props.appId
  })
  const { askVault } = useVaultActor()
  const { requestConfirmation } = useConfirmationDialogStore()
  const { requestAction: requestFileNotCachedAction } = useFileNotCachedDialogStore()

  useTask(async ({ cleanup }) => {
    const ac = new AbortController()
    cleanup(() => ac.abort())
    const cleanupBridge = await initAppBridge(state, {
      signal: ac.signal,
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
        return requestFileNotCachedAction({
          appName: payload.appName || getFileNotCachedText('App Download'),
          message
        }).then(() => retryAppBridge(state)).catch(async () => {
          const online = await onlinePromise
          for (const entry of Array.from(state.windows.values())) {
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

  return this.h`
    <iframe
      ref=${state.trustedIframeRef$}
      src=${state.trustedIframeSrc$()}
      tabindex='-1'
      aria-hidden='true'
    />
  `
})
