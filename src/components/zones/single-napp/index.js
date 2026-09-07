import { useAppSubdomain } from '#hooks/use-app-subdomain.js'
import { useInitPersonas } from '#hooks/use-personas.js'
import { f, useClosestStore, useStore, useSignal, useTask, useMemo } from '#f'
import { useWebStorage } from '#f'
import { useInitInstanceMetadata, useInstanceMetadataSurface } from '#hooks/use-instance-metadata.js'
import { appDecode } from 'libp2r2p/nip19'
import { addressObjToAppId } from '#helpers/app.js'
import { base62ToBase16 } from 'libp2r2p/base62'
import { useActiveWorkspaceOrder } from '#hooks/use-active-workspace-order.js'
import {
  APP_PENDING_INDICATOR_DELAY_MS,
  APP_PAGE_READY_TIMEOUT_MS,
  initAppWindow
} from '#helpers/window-message/app-bridge.js'
import { APP_BRIDGE_ERROR_KIND } from '#helpers/window-message/app-bridge-error.js'
import { reloadAppIframe } from '#helpers/window-message/reload-app-iframe.js'
import useAppBridgeRegistration from '#hooks/use-app-bridge-registration.js'
import { allocateAppSubdomain, subdomainStorage } from '#helpers/subdomain-mapping.js'
import { getRandomId } from '#helpers/misc.js'
import { resetDraftAppRuntimeData } from '#zones/screen/helpers/draft-app-runtime-reset.js'
import AppUpdater from '#services/app-updater/index.js'
import { formatAssetBudgetBytes } from '#services/app-asset-budget/index.js'
import { useVaultModalStore, useVaultActor } from '#zones/vault-modal/index.js'
import { useConfirmationDialogStore } from '#zones/confirmation-dialog/index.js'
import '#shared/napp-assets-caching-progress-bar.js'
import { getAssetBudgetConfirmation } from '#i18n/asset-budget.js'
import { getT } from '#i18n/index.js'
import { cssVars } from '#assets/styles/theme.js'
import { getFileNotCachedText } from '#zones/file-not-cached-dialog/index.js'
import '#zones/file-not-cached-dialog/index.js'
import '#zones/app-bridge-host.js'
import '#shared/pending-indicator.js'

export const singleNappLocales = getLocales()
const t = getT(singleNappLocales)

f('singleNapp', function () {
  // This zone runs in its own same-origin iframe, not inside the top-level
  // multi-napp component tree. The top document is usually the multi-window
  // launcher, but its stores, dialogs and DOM are in a separate Window/JS
  // realm, so providers needed by this embedded launcher must be mounted here.
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  useInitPersonas({ storage })
  useInitInstanceMetadata({ storage })
  const { order$: openWorkspaceKeys$ } = useActiveWorkspaceOrder(storage, tabStorage)
  const wsKey = openWorkspaceKeys$()[0]
  if (!wsKey) throw new Error('User n/a')

  useVaultModalStore(() => ({
    isOpen$: false,
    open () { this.isOpen$(true) },
    close () { this.isOpen$(false) }
  }))

  useClosestStore('napp', () => {
    let napp
    const initialRoute = [window.location]
      .map(loc =>
        (
          loc.pathname
            .replace(/\/\+{1,3}[^/?#]+\/?/, m => { napp = m.replace(/^\/|\/$/g, ''); return '' })
            .replace(/\/$/, '') + loc.search + loc.hash
        )
          .replace(/^([^?#])/, '/$1')
      )[0]
    const decodedApp = appDecode(napp)
    const appId = addressObjToAppId(decodedApp)

    return {
      wsKey,
      appId,
      initialRoute
    }
  })

  return this.h`
    <vault-modal />
    <confirmation-dialog />
    <file-not-cached-dialog />
    <app-bridge-host />
    <single-napp-launcher />
  `
})

// this won't add napp to web storage, it's supposed to be ephemeral-ish
f('singleNappLauncher', function () {
  const { wsKey, appId, initialRoute } = useClosestStore('napp')
  const storage = useWebStorage(localStorage)
  const {
    [`session_workspaceByKey_${wsKey}_userPk$`]: userPk$
  } = storage
  const appSubdomain$ = useAppSubdomain(() => ({ userPk: userPk$(), appId }))
  const appIframeRef$ = useSignal()
  const appIframeSrc$ = useSignal('about:blank')
  const launchError$ = useSignal(null)
  const appReady$ = useSignal(false)
  const showPending$ = useSignal(false)
  const { cachingProgress$ } = useClosestStore('<napp-assets-caching-progress-bar>', {
    cachingProgress$: {
      // [filename]: {
      //   progress: 0, // 0-100
      //   totalByteSizeEstimate: 0 // APP_FILE_CHUNK_BYTES * total chunks; tail chunks count as full chunks
      // }
    }
  })
  const { askVault } = useVaultActor()
  const { requestConfirmation } = useConfirmationDialogStore()
  const runtime = useMemo(() => ({
    startedGeneration: null,
    appReady: false,
    autoRetried: false,
    appCleanup: null,
    initialRoute: null,
    retentionRecorded: false
  }))
  const instanceId = useMemo(() => getRandomId())
  useInstanceMetadataSurface(() => `single-napp:${appId}:${userPk$()}:${instanceId}`, () => ({
    element: appIframeRef$(),
    isWidget: false,
    eligible: !launchError$(),
    contentVisible: !showPending$() && appIframeSrc$() !== 'about:blank'
  }))

  const admission = useStore({ allowed$: false })
  useTask(({ cleanup }) => {
    const activeSession = AppUpdater.tryMarkSingleNappOpen(appId)
    if (!activeSession.accepted) {
      launchError$(t('Too many embedded apps are open. Close one and try again.'))
      return
    }
    cleanup(() => activeSession.release())
    admission.allowed$(true)
  })
  const registeredBridge$ = useAppBridgeRegistration(() => admission.allowed$()
    ? ({
        appSubdomain: appSubdomain$(), userPk: userPk$(), appId
      })
    : null, ({ userPk }) => ({
    appKey: `single-napp:${appId}:${userPk}:${instanceId}`,
    cachingProgress$,
    onClose () {
      launchError$(getFileNotCachedText('Failed to load app. Retry or close it?'))
    }
  }))

  useTask(
    async ({ track, cleanup }) => {
      if (!track(() => admission.allowed$())) return
      launchError$(null)
      if (runtime.initialRoute == null) runtime.initialRoute = initialRoute || ''
      const currentRoute = runtime.initialRoute

      // Allocate numeric subdomain if needed
      const [subdomain, userPk, iframeRef] = track(() => [
        appSubdomain$(),
        userPk$(),
        appIframeRef$()
      ])
      const identity = JSON.stringify([wsKey, userPk, appId, subdomain])
      if (runtime.identity !== identity) {
        runtime.appCleanup?.()
        runtime.appCleanup = null
        runtime.identity = identity
        runtime.startedGeneration = null
        runtime.appReady = false
        runtime.autoRetried = false
        runtime.retentionRecorded = false
        appIframeSrc$('about:blank')
        appReady$(false)
      }
      if (subdomain == null && (!userPk || !appId)) return
      // `after: 'rendering'` applies only to the first run. If this task reruns
      // before a later render populates the iframe ref, return and wait for the
      // ref signal instead of wiring `initAppWindow` to a stale contentWindow.
      if (subdomain == null || !iframeRef) {
        await allocateAppSubdomain(subdomainStorage(), { userPk, appId })
        return
      }

      const ac = new AbortController()
      cleanup(() => {
        ac.abort()
      })
      showPending$(false)
      const bridgeState = track(() => registeredBridge$())
      if (!bridgeState) return
      const appKey = `single-napp:${appId}:${userPk}:${instanceId}`

      const reloadAppFrame = () => reloadAppIframe({
        appIframeRef$,
        appIframeSrc$,
        fallbackSrc: `//${subdomain}.${window.location.host}${currentRoute || '/'}`
      })
      let isDraftReloading = false
      const offDraftUpdate = AppUpdater.onDraftAppUpdated(async ({ appId: updatedAppId }) => {
        if (ac.signal.aborted || updatedAppId !== appId || isDraftReloading) return
        if (subdomain == null) return

        isDraftReloading = true
        try {
          await resetDraftAppRuntimeData({
            appId: updatedAppId,
            userPk,
            appSubdomain: subdomain
          })
          if (ac.signal.aborted) return
          reloadAppFrame()
        } finally {
          isDraftReloading = false
        }
      })
      cleanup(offDraftUpdate)

      const [bridgeReady, bridgeError, bridgeRetryCount] = track(() => [
        bridgeState.ready$(),
        bridgeState.error$(),
        bridgeState.retryCount$()
      ])
      if (bridgeError) {
        showPending$(false)
        launchError$(getFileNotCachedText('Failed to load app. Retry or close it?'))
        return
      }
      if (!bridgeReady) {
        let pendingTimer = null
        const schedulePending = () => {
          clearTimeout(pendingTimer)
          showPending$(false)
          pendingTimer = setTimeout(() => {
            if (ac.signal.aborted || bridgeReady || runtime.appReady) return
            showPending$(true)
          }, APP_PENDING_INDICATOR_DELAY_MS)
        }
        cleanup(() => clearTimeout(pendingTimer))
        schedulePending()
        appReady$(false)
        runtime.startedGeneration = null
        runtime.appReady = false
        runtime.autoRetried = false
        runtime.appCleanup = null
        return
      }
      if (!runtime.retentionRecorded && bridgeState.appFiles?.siteManifest) {
        runtime.retentionRecorded = true
        const ownerPubkey =
          userPk && userPk !== storage.session_defaultUserPk$()
            ? base62ToBase16(userPk, { mode: 'integer', byteLength: 32 }).toLowerCase()
            : ''
        AppUpdater.recordEmbeddedOnlyRetention({
          appId,
          ownerPubkey,
          siteManifest: bridgeState.appFiles.siteManifest,
          updateSiteManifestMetadata: metadata =>
            bridgeState.appFiles.updateSiteManifestMetadata(metadata),
          _localStorage: localStorage
        }).catch(error => {
          console.warn('[single-napp] Failed to record embedded-only retention', error)
        })
      }
      if (runtime.startedGeneration === bridgeRetryCount && runtime.appReady) return

      runtime.appCleanup?.()
      runtime.appCleanup = null
      runtime.startedGeneration = bridgeRetryCount
      runtime.appReady = false
      runtime.autoRetried = false
      appReady$(false)

      let appPageTimeout = null
      const onAppReady = () => {
        if (ac.signal.aborted || runtime.identity !== identity) return
        clearTimeout(appPageTimeout)
        showPending$(false)
        runtime.appReady = true
        appReady$(true)
      }
      const cleanupApp = initAppWindow(bridgeState, {
        appKey,
        wsKey,
        initialRoute: currentRoute,
        onRouteChanged: route => { runtime.initialRoute = route },
        appIframeRef$,
        appIframeSrc$,
        cachingProgress$,
        askVault,
        requestPermission () {
          throw new Error('Permission request not available in single napp mode yet')
        },
        openApp () {
          throw new Error('Open app not available in single napp mode yet')
        },
        onFileNotCached: details => bridgeState.bridgeErrorHandler?.(details),
        requestAssetBudgetConfirmation: details => requestConfirmation(getAssetBudgetConfirmation({
          ...details,
          formatBytes: formatAssetBudgetBytes
        })),
        onAppReady,
        signal: ac.signal
      })
      runtime.appCleanup = cleanupApp
      cleanup(cleanupApp)

      appPageTimeout = setTimeout(() => {
        if (ac.signal.aborted || runtime.appReady) return
        if (!runtime.autoRetried) {
          runtime.autoRetried = true
          reloadAppFrame()
          return
        }
        bridgeState.bridgeErrorHandler?.({
          pathname: 'index.html',
          message: getFileNotCachedText('Failed to load app. Retry or close it?'),
          kind: APP_BRIDGE_ERROR_KIND.APP_PAGE
        })
      }, APP_PAGE_READY_TIMEOUT_MS)
      cleanup(() => clearTimeout(appPageTimeout))
    },
    { after: 'rendering' }
  )

  return this.h`
      <style>${`
        single-napp-launcher {
          position: relative;
          display: block;
          width: 100%;
          height: 100%;
          overflow: hidden;
        }

        iframe {
          &.napp-page {
            border: none;
            width: 100%;
            height: 100%;
            display: block; /* ensure it's not inline */
          }
        }

        .embedded-pending {
          position: absolute;
          inset: 0;
          z-index: 1;
          background-color: ${cssVars.colors.bg};
        }

        .embedded-load-error {
          height: 100%;
          display: grid;
          place-items: center;
          padding: 24px;
          color: ${cssVars.colors.fg};
          background: ${cssVars.colors.bg};
          font-size: 14rem;
          line-height: 1.45;
          text-align: center;
        }
      `}</style>
      ${launchError$()
        ? this.h`<div class='embedded-load-error'>${launchError$()}</div>`
        : this.h`
          <napp-assets-caching-progress-bar />
          <iframe
          class='napp-page'
          allow='fullscreen; screen-wake-lock; ambient-light-sensor;
                 autoplay; midi; encrypted-media;
                 accelerometer; gyroscope; magnetometer; xr-spatial-tracking;
                 clipboard-read; clipboard-write; web-share;
                 camera; microphone;
                 geolocation;
                 bluetooth;
                 payment'
            ref=${appIframeRef$}
            src=${appIframeSrc$()}
          />
          ${showPending$()
            ? this.h`
                <div class='embedded-pending'>
                  <pending-indicator props=${{ text: t('Opening app...') }} />
                </div>
              `
            : ''}
        `}
  `
})

function getLocales () {
  return {
    'Opening app...': {
      en: 'Opening app...', fr: 'Ouverture de l’application...', it: 'Apertura dell’app...', de: 'App wird geöffnet...', es: 'Abriendo la aplicación...', 'pt-BR': 'Abrindo o app...', ru: 'Открытие приложения...', 'zh-CN': '正在打开应用...', 'zh-TW': '正在開啟應用程式...', ja: 'アプリを開いています…', ko: '앱을 여는 중...'
    },
    'Too many embedded apps are open. Close one and try again.': {
      en: 'Too many embedded apps are open. Close one and try again.', fr: 'Trop d’applications intégrées sont ouvertes. Fermez-en une et réessayez.', it: 'Sono aperte troppe app incorporate. Chiudine una e riprova.', de: 'Zu viele eingebettete Apps sind geöffnet. Schließen Sie eine und versuchen Sie es erneut.', es: 'Hay demasiadas aplicaciones integradas abiertas. Cierra una y vuelve a intentarlo.', 'pt-BR': 'Há apps incorporados demais abertos. Feche um deles e tente novamente.', ru: 'Открыто слишком много встроенных приложений. Закройте одно и повторите попытку.', 'zh-CN': '打开的嵌入式应用过多。请关闭一个后重试。', 'zh-TW': '開啟的嵌入式應用程式過多。請關閉一個後重試。', ja: '埋め込みアプリが多すぎます。1つ閉じてからもう一度お試しください。', ko: '열려 있는 임베디드 앱이 너무 많습니다. 하나를 닫고 다시 시도하세요.'
    }
  }
}
