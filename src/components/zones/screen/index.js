import { f, useCallback, useComputed, useStore, useGlobalStore, useGlobalSignal, useStateSignal, useSignal, useClosestSignal, useClosestStore, useTask, useMemo } from '#f'
import AppUpdater from '#services/app-updater/index.js'
import useInitOrResetScreen from './use-init-or-reset-screen.js'
import useTrackAccountEvents from './use-track-account-events.js'
import { useWebStorage } from '#f'
// import useLongPress from '#hooks/use-long-press.js'
import useScrollbarConfig from '#hooks/use-scrollbar-config.js'
import useIsMobile from '#hooks/use-is-mobile.js'
import '#shared/menu.js'
import '#shared/avatar.js'
import {
  cssVars,
  jsVars
} from '#assets/styles/theme.js'
import windowsBackgroundImage from '#assets/media/bg-ostrich-stained-glass.webp'
import windowsBackgroundLightImage from '#assets/media/bg-ostrich-stained-glass-light.webp'
import windowsBackgroundLightPattern from '#assets/media/bg-stone-wall-light-pattern.webp'
import useAppRouter from './use-app-router.js'
import useSystemRouter from './use-system-router.js'
import {
  hasAnyRecentSingleNappOpen
} from './helpers/nostrdb-app-lifecycle.js'
import {
  removeAppFromWorkspace,
  uninstallAppFromWorkspace
} from './helpers/app-lifecycle.js'
import { shouldApplyVirtualWidth } from '#services/widgets/index.js'
import { resetDraftAppRuntimeData } from './helpers/draft-app-runtime-reset.js'
import { usePermissionDialogStore } from '#zones/permission-dialog/index.js'
import { getFileNotCachedText } from '#zones/file-not-cached-dialog/index.js'
import '#shared/route.js'
import {
  APP_PENDING_INDICATOR_DELAY_MS,
  APP_PAGE_READY_TIMEOUT_MS,
  initAppWindow
} from '#helpers/window-message/app-bridge.js'
import { APP_BRIDGE_ERROR_KIND } from '#helpers/window-message/app-bridge-error.js'
import {
  ensureAppBridgeState,
  registerAppBridgeWindow
} from '#helpers/window-message/app-bridge-registry.js'
import { appEncode } from 'libp2r2p/nip19'
import { appIdToAddressObj } from '#helpers/app.js'
import { copyTextToClipboard } from '#helpers/copy-text.js'
import { allocateAppSubdomain } from '#helpers/subdomain-mapping.js'
import { useVaultModalStore, useVaultActor } from '#zones/vault-modal/index.js'
import { base62ToBase16 } from 'libp2r2p/base62'
import { formatAssetBudgetBytes } from '#services/app-asset-budget/index.js'
import { useConfirmationDialogStore } from '#zones/confirmation-dialog/index.js'
import { scheduleStorageRepair } from '#services/storage-audit/bootstrap.js'
import '#shared/napp-assets-caching-progress-bar.js'
import '#shared/app-icon.js'
import '#shared/pending-indicator.js'
import 'thenameisf/components/f-svg.js'
import '#shared/icons/icon-close.js'
import '#shared/icons/icon-minimize.js'
import '#shared/icons/icon-maximize.js'
import '#shared/icons/icon-stack-front.js'
import '#shared/icons/icon-remove.js'
import '#shared/icons/icon-wash-dry-shade.js'
import '#shared/icons/icon-delete.js'
import '#shared/icons/icon-lock.js'
import '#shared/icons/icon-library-plus.js'
import '#shared/icons/icon-share-2.js'
import '#shared/icons/icon-copy.js'
import '#shared/icons/icon-pencil-off.js'
import '#shared/signer-request-tooltip.js'
import { getAssetBudgetConfirmation } from '#i18n/asset-budget.js'
import { getEffectiveLocale, getT } from '#i18n/index.js'
import {
  clearSignerRequestAttention,
  signerRequestAttention$
} from '#helpers/signer-request-attention.js'
import {
  useActiveWorkspaceOrder
} from '#hooks/use-active-workspace-order.js'
import './menus/toolbar-more-menu.js'
import './menus/other-users-app-groups.js'
import './widgets/index.js'
import { otherUsersGroupPopoverOpen$ } from './menus/other-users-app-groups.js'
import {
  FIRST_ACCOUNT_ATTENTION_SIGNAL,
  shouldShowFirstAccountAttention
} from './account-attention.js'

export const screenLocales = getLocales()

const t = getT(screenLocales)
const DEFAULT_DOCUMENT_TITLE = '44billion'

f('aScreen', function () {
  useInitOrResetScreen()
  useTrackAccountEvents()
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const { order$: activeWsOrder$ } = useActiveWorkspaceOrder(storage, tabStorage)

  // No track: the audit should run once, not react to workspace changes.
  // Register before useAppRouter so a repair reload preserves the original
  // app URL instead of reloading after the router reset the tab to "/".
  useTask(() => {
    if (!storage.session_workspaceKeys$()?.length) return
    scheduleStorageRepair().catch(error => {
      console.error('[storage-audit] Failed to schedule repair', error)
    })
  })

  // The focused/visible tab's workspace order becomes the canonical order
  // used to initialize new tabs (last-writer-wins on focus).
  useTask(({ cleanup }) => {
    const syncCanonicalOrder = () => {
      if (document.visibilityState !== 'visible') return
      const next = activeWsOrder$()
      const current = storage.session_openWorkspaceKeys$?.() ?? []
      const currentList = Array.isArray(current) ? current : []
      if (
        next.length === currentList.length &&
        next.every((key, index) => key === currentList[index])
      ) return
      storage.session_openWorkspaceKeys$(next)
    }

    syncCanonicalOrder()
    window.addEventListener('focus', syncCanonicalOrder)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') syncCanonicalOrder()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    cleanup(() => {
      window.removeEventListener('focus', syncCanonicalOrder)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    })
  })

  useAppRouter()
  const { isSystemRoute$ } = useSystemRouter()
  const widgetsRevealActive$ = useGlobalSignal('widgetsRevealActive', false)

  // Keep the browser tab title in sync with the focused app. System routes
  // always use the default launcher title, and the title only follows an app
  // while it is actually open in the active workspace.
  useTask(({ track }) => {
    const focusedApp = track(() => {
      if (isSystemRoute$()) return null

      const wsKeys = activeWsOrder$() ?? []
      const wsKey = wsKeys[0]
      if (!wsKey) return null

      const openAppKeys = tabStorage[`session_workspaceByKey_${wsKey}_openAppKeys$`]() ?? []
      for (const appKey of openAppKeys) {
        const visibility = tabStorage[`session_appByKey_${appKey}_visibility$`]()
        if (visibility !== 'open') continue

        const appId = storage[`session_appByKey_${appKey}_id$`]()
        if (!appId) continue

        const appName = storage[`session_appById_${appId}_name$`]()
        return appName ? { appId, appName } : { appId, appName: '' }
      }

      return null
    })

    document.title = focusedApp?.appName || DEFAULT_DOCUMENT_TITLE
  })

  // Listen for subdomain redirect requests from other tabs
  useTask(({ cleanup }) => {
    const bc = new BroadcastChannel('44billion_subdomain_nav')
    cleanup(() => bc.close())
    bc.onmessage = (e) => {
      const { href, userPk } = e.data
      if (!href) return
      // Find the workspace for the target user without switching active workspace
      let wsKey
      if (userPk) {
        wsKey = (storage.session_workspaceKeys$() || []).find(
          k => storage[`session_workspaceByKey_${k}_userPk$`]() === userPk
        )
      }
      try {
        const { openApp } = useGlobalStore('useAppRouter')
        openApp(href, wsKey)
      } catch (err) { console.error('Subdomain nav failed', err) }
    }
  })

  const isSingleWindow$ = storage.config_isSingleWindow$
  const { isHidden$: isToolbarHidden$ } = useGlobalStore('toolbarState', { isHidden$: false })

  // While the widget reveal mode is active, the toolbar must stay available:
  // if the user hides it (which enters fullscreen), bring it back without
  // leaving fullscreen so the mode can be dismissed.
  useTask(({ track }) => {
    const active = track(() => widgetsRevealActive$())
    const hidden = track(() => isToolbarHidden$())
    if (active && hidden) isToolbarHidden$.set(false)
  })

  // Escape dismisses the widget reveal mode.
  useTask(({ cleanup }) => {
    const onKeyDown = event => {
      if (event.key === 'Escape' && widgetsRevealActive$()) widgetsRevealActive$(false)
    }
    window.addEventListener('keydown', onKeyDown)
    cleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  const style$ = useComputed(() => /* css */`
    /* @scope { */
    #screen {
      & {
        display: flex;
        width: 100dvw;
        height: 100dvh;
        position: relative;

        @media (orientation: landscape) {
          flex-direction: row; /* -reverse; */
        }
        @media (orientation: portrait) {
          flex-direction: column;
        }
        /**/
      }
    }

    #workspaces {
      flex: 1;
      position: relative;

      /* system views stay above the whole #windows stack (z-index 1 here).
         Inside #windows: background 0, widgets 1, workspace windows 2. */
      #system-views {
        display: ${isSystemRoute$() ? 'flex' : 'none'} !important;
        justify-content: center;
        background-color: ${cssVars.colors.bg};
        position: absolute;
        inset: 0;
        z-index: 1;
        overflow: hidden;
      }

      #windows {
        display: flex !important;
        @media (orientation: portrait) {
          flex-direction: column;
        }
        position: absolute;
        inset: 0;
        z-index: 0;
        overflow: hidden;
      }
    }

    #unified-toolbar {
      display: flex !important;
      flex: 0 0 auto;
      background-color: ${cssVars.colors.bg2};
      overflow: hidden;
      transition: min-width 0.3s ease-in-out, width 0.3s ease-in-out, min-height 0.3s ease-in-out, height 0.3s ease-in-out, opacity 0.3s ease-in-out;

      @media (orientation: portrait) {
        min-height: ${isToolbarHidden$() ? '0px' : '50px'};
        height: ${isToolbarHidden$() ? '0px' : '50px'};
        opacity: ${isToolbarHidden$() ? '0' : '1'};
      }
      @media (orientation: landscape) {
        flex-direction: column;
        min-width: ${isToolbarHidden$() ? '0px' : '50px'};
        width: ${isToolbarHidden$() ? '0px' : '50px'};
        opacity: ${isToolbarHidden$() ? '0' : '1'};
      }
      /**/
    }

    #screen.system-route-active toolbar-app-launcher > div,
    #screen.widgets-reveal-active toolbar-app-launcher > div {
      filter: grayscale(1);
      opacity: .65;
    }
    app-window .scope_khjha3.open {
      transition: opacity 0.25s ease-in-out;
    }
    #screen.widgets-reveal-active app-window .scope_khjha3.open {
      opacity: 0;
      pointer-events: none;
    }
  `)

  const unifiedToolbarRef$ = useClosestSignal('unifiedToolbarRef', null)

  return this.h`
    <div id="screen" class=${{
      'multi-window': !isSingleWindow$(),
      'system-route-active': isSystemRoute$(),
      'widgets-reveal-active': widgetsRevealActive$()
    }}>
      <style>${style$()}</style>
      <div id='workspaces'>
        <a-windows id='windows' />
        <system-views id='system-views' />
      </div>
      <unified-toolbar ref=${unifiedToolbarRef$} id='unified-toolbar' />
      <toolbar-restore-button />
    </div>
  `
})

f('system-views', function () {
  return this.h`
    <a-route props=${{ path: '/settings' }} />
    <a-route props=${{ path: '/app-updates' }} />
    <a-route props=${{ path: '/sticky-sessions' }} />
  `
})

f('aWindows', function () {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  // Order is important, that's why we didn't compute from workspaceKeys$
  // Recently opened/clicked first; each tab keeps its own order.
  const { order$: openWorkspaceKeys$ } = useActiveWorkspaceOrder(storage, tabStorage)

  const stableDomOrderWsKeys$ = useSignal([])
  useTask(({ track }) => {
    const nextKeys = track(() => openWorkspaceKeys$())
    stableDomOrderWsKeys$(v => {
      return v.concat(nextKeys.filter(k => !v.includes(k)))
    })
  })
  const mruRankByWsKey$ = useComputed(() => openWorkspaceKeys$().reduce((r, v, i) => ({ ...r, [v]: i + 1 }), {}))

  return this.h`
    ${stableDomOrderWsKeys$().map(workspaceKey =>
      this.h({
        key: workspaceKey
      })`<workspace-window key=${workspaceKey} props=${{ workspaceKey, mruRankByWsKey$ }} />`
    )}
    <widgets-layer />
    <windows-background />
  `
})
f('windowsBackground', function () {
  return this.h`
    <div
      id='windows-background'
      style=${`
        background-color: ${cssVars.colors.bg};
        display: flex;
        align-items: flex-end;
        justify-content: center;
        text-align: center;
        padding: clamp(24px, 6vmin, 80px);
        color: ${cssVars.colors.fg2};
        z-index: 0;
        inset: 0;
        position: absolute;
      `}
    >
      <style>${`
        #windows-background {
          background-image: url(${windowsBackgroundImage});
          background-position: center;
          background-repeat: no-repeat;
          background-size: contain;
          user-select: none;
          -webkit-user-select: none;

          @media ${jsVars.breakpoints.desktop} {
            background-origin: content-box;
          }

          #windows-background-light-art {
            display: none;
          }

          #windows-background-message {
            position: relative;
            z-index: 2;
          }

          @media (prefers-color-scheme: light) {
            background-image: url(${windowsBackgroundLightPattern});
            background-origin: border-box;
            background-repeat: repeat;
            background-size: clamp(220px, 65vmin, 560px);

            #windows-background-light-art {
              display: block;
              position: absolute;
              inset: 0;
              margin: auto;
              width: min(calc(100% - 32px), 560px);
              height: min(calc(100% - 32px), 800px);
              background-image: url(${windowsBackgroundLightImage});
              background-position: center;
              background-repeat: no-repeat;
              background-size: contain;
              filter: drop-shadow(0 8px 18px ${cssVars.colors.shadow});
              pointer-events: none;
            }
          }
        }
      `}</style>
      <div id='windows-background-light-art' aria-hidden='true'></div>
      <span id='windows-background-message'>${t('Please open an app')}</span>
    </div>
  `
})
f('workspaceWindow', function () {
  const tabStorage = useWebStorage(sessionStorage)
  // App instances are useful for grouping app icons, but windows are not grouped by app
  // That's why we have openAppKeys$ instead of openAppIds$
  const {
    [`session_workspaceByKey_${this.props.workspaceKey}_openAppKeys$`]: openAppKeys$
  } = tabStorage

  // Calculate stable DOM order at runtime (similar to workspace windows)
  const stableDomOrderAppKeys$ = useSignal([])
  useTask(({ track }) => {
    const nextKeys = track(() => openAppKeys$()) ?? []
    stableDomOrderAppKeys$(v => {
      return v.concat(nextKeys.filter(k => !v.includes(k)))
    })
  })

  const mruRankByAppKey = useComputed(() =>
    (openAppKeys$() ?? []).reduce((r, v, i) => ({
      ...r,
      [v]: `${this.props.mruRankByWsKey$()[this.props.workspaceKey]}-${i + 1}`
    }), {})
  )()
  return this.h`
    ${stableDomOrderAppKeys$().map(appKey => {
      const mruRank = mruRankByAppKey[appKey]
      return this.h({ key: appKey })`
      <app-window key=${appKey} props=${{ appKey, wsKey: this.props.workspaceKey, mruRank }} />
      `
    })}
  `
})
f('appWindow', function () {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const {
    [`session_appByKey_${this.props.appKey}_id$`]: appId$,
    [`session_appByKey_${this.props.appKey}_route$`]: initialRoute$,
    [`session_workspaceByKey_${this.props.wsKey}_userPk$`]: userPk$
  } = storage
  const {
    [`session_appByKey_${this.props.appKey}_visibility$`]: appVisibility$
  } = tabStorage
  const appSubdomain$ = useComputed(() => {
    const userPk = userPk$()
    const appId = appId$()
    if (!userPk || !appId) return null
    return storage[`session_subdomainByUserAndApp_${userPk}_${appId}$`]()
  })
  const isClosed$ = useComputed(() => appVisibility$() === 'closed')
  const appIframeRef$ = useSignal(null)
  const appIframeSrc$ = useSignal('about:blank')
  const appReady$ = useSignal(false)
  const showPending$ = useSignal(false)
  const launchError$ = useSignal(null)
  const windowRootRef$ = useSignal(null)
  const windowWidth$ = useSignal(null)
  const windowHeight$ = useSignal(null)
  const minWidth$ = useSignal(0)
  const virtualWidth$ = useSignal(false)
  const iframeReevalHidden$ = useSignal(false)
  const reeval = useMemo(() => ({ lastWidth: null, lastMinWidth: null }))
  const { cachingProgress$ } = useClosestStore('<napp-assets-caching-progress-bar>', {
    cachingProgress$: {
      // [filename]: {
      //   progress: 0, // 0-100
      //   totalByteSizeEstimate: 0 // APP_FILE_CHUNK_BYTES * total chunks; tail chunks count as full chunks
      // }
    }
  })
  const { askVault } = useVaultActor()
  const pdStore = usePermissionDialogStore()
  const { requestPermission } = pdStore
  const { openApp } = useGlobalStore('useAppRouter')
  const { requestConfirmation } = useConfirmationDialogStore()
  const appKey = this.props.appKey
  const wsKey = this.props.wsKey
  const runtime = useMemo(() => ({
    startedGeneration: null,
    appReady: false,
    autoRetried: false,
    appCleanup: null,
    initialRoute: null,
    routeConsumed: false,
    routeVersion: 0,
    loadedRouteVersion: -1
  }))

  useTask(({ track, cleanup }) => {
    const root = track(() => windowRootRef$())
    if (!root) return
    const update = () => {
      windowWidth$(root.clientWidth)
      windowHeight$(root.clientHeight)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(root)
    cleanup(() => observer.disconnect())
  }, { after: 'rendering' })

  useTask(({ track }) => {
    const width = track(() => windowWidth$())
    const minWidth = track(() => minWidth$())
    if (width == null) return
    const applyVirtual = shouldApplyVirtualWidth(width, minWidth)
    const widthChanged = reeval.lastWidth !== null && width !== reeval.lastWidth
    const minWidthChanged = reeval.lastMinWidth !== null && minWidth !== reeval.lastMinWidth
    reeval.lastWidth = width
    reeval.lastMinWidth = minWidth
    const modeChanged = virtualWidth$() !== applyVirtual
    if (!widthChanged && !minWidthChanged && !modeChanged) return
    virtualWidth$(applyVirtual)
    if (modeChanged || (applyVirtual && minWidthChanged)) iframeReevalHidden$(true)
  })

  const removeCurrentApp = async () => {
    const currentAppId = appId$()
    const currentUserPk = userPk$()
    const currentAppSubdomain = appSubdomain$()
    if (!currentAppId || !currentUserPk) return
    const appKeys = storage[`session_workspaceByKey_${wsKey}_appById_${currentAppId}_appKeys$`]()
    if (!appKeys || !appKeys.includes(appKey)) return
    if (appKeys.length === 1) {
      const preserveAppMetadata = await hasAnyRecentSingleNappOpen({ appId: currentAppId })
      await uninstallAppFromWorkspace({
        storage,
        tabStorage,
        wsKey,
        appKey,
        appId: currentAppId,
        userPk: currentUserPk,
        appSubdomain: currentAppSubdomain,
        preserveAppMetadata
      })
      return
    }
    removeAppFromWorkspace({
      storage,
      tabStorage,
      wsKey,
      appKey,
      appId: currentAppId,
      userPk: currentUserPk,
      appSubdomain: currentAppSubdomain
    })
  }

  useTask(
    async ({ track, cleanup }) => {
      const [isClosed, iframeRef, appSubdomain, appId, userPk] = track(() => [
        isClosed$(),
        appIframeRef$(),
        appSubdomain$(),
        appId$(),
        userPk$()
      ])
      // The initial route is consumed once by onAppReady, then kept in
      // storage so the app can be restored at the same URL later. Reading it
      // outside `track` keeps those storage writes from re-running this task:
      // a re-run would first run the previous cleanup, which closes the app
      // page MessagePort, and the early-return guard below would leave the
      // port closed forever.
      const routeValue = initialRoute$()
      launchError$(null)
      // This component is reused on open -> closed -> open: stableDomOrderAppKeys$
      // retains the app key, while the render returns nothing while closed. The
      // refs/signals must be reset here so the next open starts from a clean iframe.
      if (isClosed) {
        cachingProgress$({})
        appIframeSrc$('about:blank')
        appIframeRef$(null)
        appReady$(false)
        showPending$(false)
        launchError$(null)
        virtualWidth$(false)
        iframeReevalHidden$(false)
        minWidth$(0)
        runtime.startedGeneration = null
        runtime.appReady = false
        runtime.autoRetried = false
        runtime.appCleanup = null
        runtime.initialRoute = null
        runtime.routeConsumed = false
        runtime.routeVersion++
        runtime.loadedRouteVersion = -1
        // Closing an instance resets its route: reopening it must start from
        // the root instead of returning to a possibly broken route.
        initialRoute$('')
        return
      }
      // `after: 'rendering'` applies only to the first run. On a subsequent
      // reopen, useTask runs before rendering, so `iframeRef` may still be null
      // from the closed state. Return here and wait for the ref signal to be
      // repopulated; otherwise initAppWindow could compare `e.source` against
      // the previous iframe's contentWindow and miss APP_IFRAME_READY.
      if (!iframeRef) return

      if (appSubdomain == null && (!appId || !userPk)) return
      if (appSubdomain == null) {
        allocateAppSubdomain(storage, { userPk, appId })
        return
      }

      if (routeValue && !runtime.routeConsumed && routeValue !== runtime.initialRoute) {
        runtime.initialRoute = routeValue
        runtime.routeVersion++
      }
      if (runtime.initialRoute == null) runtime.initialRoute = routeValue || ''
      const initialRoute = runtime.initialRoute
      const ac = new AbortController()
      cleanup(() => ac.abort())
      showPending$(false)
      const bridgeState = ensureAppBridgeState(appSubdomain, { userPk, appId })
      const unregisterBridgeWindow = registerAppBridgeWindow(bridgeState, {
        appKey,
        cachingProgress$,
        onClose () {
          tabStorage[`session_appByKey_${appKey}_visibility$`]('closed')
          tabStorage[`session_workspaceByKey_${wsKey}_openAppKeys$`]((v = [], eqKey) => {
            const i = v.indexOf(appKey)
            if (i !== -1) { v.splice(i, 1); v[eqKey] = Math.random() }
            return v
          })
        },
        onSetMinWidth (minWidth) {
          const value = Math.round(Number(minWidth))
          if (!Number.isFinite(value) || value < 0) {
            console.warn('[app-window] Invalid minWidth', minWidth)
            return
          }
          minWidth$(value)
        },
        onAutoFitDone () {
          iframeReevalHidden$(false)
        },
        onRemove: removeCurrentApp
      })
      cleanup(unregisterBridgeWindow)

      let isDraftReloading = false
      const offDraftUpdate = AppUpdater.onDraftAppUpdated(async ({ appId: updatedAppId }) => {
        if (ac.signal.aborted || updatedAppId !== appId || isClosed$() || isDraftReloading) return
        if (appSubdomain == null) return
        isDraftReloading = true
        try {
          await resetDraftAppRuntimeData({
            appId: updatedAppId,
            userPk,
            appSubdomain
          })
          if (ac.signal.aborted) return
          try {
            appIframeRef$()?.contentWindow?.location?.reload()
          } catch (err) {
            console.warn('[app-window] Direct reload failed; restoring previous iframe URL', err)
            const currentSrc = appIframeSrc$()
            appIframeSrc$('about:blank')
            await new Promise(resolve => setTimeout(resolve, 0))
            if (!ac.signal.aborted) {
              appIframeSrc$(
                currentSrc && currentSrc !== 'about:blank'
                  ? currentSrc
                  : `//${appSubdomain}.${window.location.host}${runtime.initialRoute || '/'}`
              )
            }
          }
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
        launchError$(getFileNotCachedText('Failed to load app. Retry or remove it?'))
        runtime.startedGeneration = null
        runtime.appReady = false
        appReady$(false)
        return
      }
      if (!bridgeReady) {
        let pendingTimer = null
        // Wait briefly before covering the window. If the bridge comes up fast,
        // the real app-page-loader (inside the iframe) is already visible and is
        // a better waiting UI than our generic hourglass.
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
        runtime.startedGeneration = null
        runtime.appReady = false
        runtime.autoRetried = false
        runtime.appCleanup = null
        appReady$(false)
        return
      }
      if (
        runtime.startedGeneration === bridgeRetryCount &&
        runtime.appReady &&
        runtime.loadedRouteVersion === runtime.routeVersion
      ) return

      runtime.appCleanup?.()
      runtime.appCleanup = null
      runtime.startedGeneration = bridgeRetryCount
      runtime.appReady = false
      runtime.autoRetried = false
      appReady$(false)
      launchError$(null)

      const reloadAppFrame = async () => {
        const currentSrc = appIframeSrc$()
        try {
          appIframeRef$()?.contentWindow?.location?.reload()
        } catch (err) {
          console.warn('[app-window] Retry reload failed; restoring previous iframe URL', err)
          appIframeSrc$('about:blank')
          await new Promise(resolve => setTimeout(resolve, 0))
          if (!ac.signal.aborted) {
            appIframeSrc$(
              currentSrc && currentSrc !== 'about:blank'
                ? currentSrc
                : `//${appSubdomain}.${window.location.host}${runtime.initialRoute || '/'}`
            )
          }
        }
      }

      let appPageTimeout = null
      const onAppReady = () => {
        clearTimeout(appPageTimeout)
        showPending$(false)
        runtime.appReady = true
        runtime.routeConsumed = true
        appReady$(true)
      }
      runtime.loadedRouteVersion = runtime.routeVersion
      if (IS_DEVELOPMENT) {
        console.info('[app-window] applying initial route', {
          appKey,
          initialRoute
        })
      }
      const cleanupApp = initAppWindow(bridgeState, {
        appKey,
        wsKey,
        instanceKind: 'window',
        initialRoute,
        appIframeRef$,
        appIframeSrc$,
        cachingProgress$,
        askVault,
        requestPermission,
        openApp,
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

  if (isClosed$()) return
  const windowWidth = windowWidth$()
  const windowHeight = windowHeight$()
  const minWidth = minWidth$()
  const iframeVisibility = iframeReevalHidden$() ? 'hidden' : ''
  const iframeStyle = virtualWidth$() && windowWidth && windowWidth > 0 && minWidth > 0
    ? `position:absolute;top:0;left:0;width:${minWidth}px;` +
      `height:${Math.round(windowHeight * minWidth / windowWidth)}px;` +
      `transform:scale(${windowWidth / minWidth});` +
      `transform-origin:top left;${iframeVisibility ? `visibility:${iframeVisibility};` : ''}`
    : (iframeVisibility ? `visibility:${iframeVisibility};` : '')

  return this.h`
    <div
      ref=${windowRootRef$}
      style=${`
        background-color: ${cssVars.colors.bg};
      `}
      class=${{
        open: appVisibility$() === 'open',
        scope_khjha3: true,
        [`mru-rank-${this.props.mruRank ?? 'none'}`]: !!this.props.mruRank
      }}
    >
    <style>${/* css */`
      .scope_khjha3 {
        & {
          /* Hidden windows keep their box (absolute + visibility:hidden) so
             the app iframe keeps a non-zero viewport. display:none would
             collapse the app document to zero height and clamp its scroll to
             the top when the window is shown again. */
          position: absolute;
          inset: 0;
          visibility: hidden;
          z-index: 2;
          flex: 0 1 100%;
          overflow: hidden;

          @media (orientation: portrait) {
            width: 100%;
          }
          @media (orientation: landscape) {
            height: 100%;
          }
          /**/
          iframe {
            &.napp-page {
              border: none;
              width: 100%;
              height: 100%;
              display: block; /* ensure it's not inline */
            }
          }

          .app-window-pending {
            position: absolute;
            inset: 0;
            z-index: 1;
            background-color: ${cssVars.colors.bg};
          }

          .app-window-error {
            position: absolute;
            inset: 0;
            z-index: 1;
            display: grid;
            place-items: center;
            padding: 24px;
            background-color: ${cssVars.colors.bg};
            color: ${cssVars.colors.fg};
            font-size: 14rem;
            text-align: center;
            text-wrap: balance;
          }
        }
        &.mru-rank-1-1 { order: 0; }
        &.mru-rank-1-2 { order: 1; }
        &.mru-rank-1-3 { order: 2; }
        &.mru-rank-2-1 { order: 3; }
        &.mru-rank-2-2 { order: 4; }
        &.mru-rank-2-3 { order: 5; }
        &.mru-rank-3-1 { order: 6; }
        &.mru-rank-3-2 { order: 7; }
        &.mru-rank-3-3 { order: 8; }
        &.mru-rank-1-1.open, &.mru-rank-2-1.open, &.mru-rank-3-1.open {
          position: relative;
          visibility: visible;
        }
        #screen.multi-window &.open {
          &.mru-rank-1-2, &.mru-rank-2-2, &.mru-rank-3-2 {
            position: relative;
            visibility: visible;
          }
          /* thin or thinner (shrinking number) */
          @media (max-aspect-ratio: 8/16) {
            &.mru-rank-1-3, &.mru-rank-2-3, &.mru-rank-3-3 {
              position: relative;
              visibility: visible;
            }
          }
          /* short or shorter (growing number) */
          @media (min-aspect-ratio: 16/8) {
            &.mru-rank-1-3, &.mru-rank-2-3, &.mru-rank-3-3 {
              position: relative;
              visibility: visible;
            }
          }
        }
      }
    `}</style>
    <napp-assets-caching-progress-bar />
    ${launchError$()
      ? this.h`<div class='app-window-error'>${launchError$()}</div>`
      : this.h`
        <iframe
          class='napp-page'
          style=${iframeStyle}
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
              <div class='app-window-pending'>
                <pending-indicator props=${{ text: t('Opening app...') }} />
              </div>
            `
          : ''}
      `}
    </div>
  `
})

// multi-window or not, we use a single toolbar
// if multi-window we update its content with the
// last selected workspace (a user may have many workspaces)
f('unifiedToolbar', function () {
  const scrollbar$ = useScrollbarConfig()

  return this.h`
    <style>${`
      /* @scope { */
      #unified-toolbar {
        toolbar-active-avatar {
          flex: 0 0 auto;
          display: flex !important;

          @media (orientation: portrait) {
            padding-left: 7px;
            padding-right: 7px; /* owns the gap to the app list so the edge fade sits flush */
          }
          @media (orientation: landscape) {
            flex-direction: column;
            padding-top: 7px;
            padding-bottom: 7px;
            /**/
          }

          align-items: center;
        }

        toolbar-app-list {
          flex: 1;
          display: flex !important;
          align-items: center;
          overflow: auto hidden;
          gap: 7px;
          padding: 0;

          &.fade-start {
            -webkit-mask-image: linear-gradient(to right, transparent, black 14px, black 100%);
            mask-image: linear-gradient(to right, transparent, black 14px, black 100%);
          }
          &.fade-end {
            -webkit-mask-image: linear-gradient(to right, black calc(100% - 14px), transparent);
            mask-image: linear-gradient(to right, black calc(100% - 14px), transparent);
          }
          &.fade-start.fade-end {
            -webkit-mask-image: linear-gradient(to right, transparent, black 14px, black calc(100% - 14px), transparent);
            mask-image: linear-gradient(to right, transparent, black 14px, black calc(100% - 14px), transparent);
          }

          @media (orientation: landscape) {
            flex-direction: column;
            overflow: hidden auto;
            padding: 0;

            &.fade-start {
              -webkit-mask-image: linear-gradient(to bottom, transparent, black 14px, black 100%);
              mask-image: linear-gradient(to bottom, transparent, black 14px, black 100%);
            }
            &.fade-end {
              -webkit-mask-image: linear-gradient(to top, transparent, black 14px, black 100%);
              mask-image: linear-gradient(to top, transparent, black 14px, black 100%);
            }
            &.fade-start.fade-end {
              -webkit-mask-image: linear-gradient(to bottom, transparent, black 14px, black calc(100% - 14px), transparent);
              mask-image: linear-gradient(to bottom, transparent, black 14px, black calc(100% - 14px), transparent);
            }
          }

          ${scrollbar$.get(false).hasOverlay
            ? ''
            : /* css */`
            scrollbar-color: ${cssVars.colors.scrollbarThumb} transparent; /* thumb track */
            transition: scrollbar-color .3s;
            &:hover {
              scrollbar-color: ${cssVars.colors.scrollbarThumbHover} transparent;
            }

            scrollbar-width: thin;
            @media (orientation: landscape) {
              /*
                scrollbar-gutter on chrome works just for vertical scrollbars due to a bug
                Considering we can't reliably set styles for specific browsers, we are going
                to restrict it to landscape for everyone
              */
              scrollbar-gutter: stable;
              scrollbar-width: unset; /* or else left prop won't work correctly */
              toolbar-app-launcher > div {
                position: relative;
                left: ${Math.floor(scrollbar$.get(false).width / 2)}px;
              }
            }
          `}
        }
        /**/
      }
    `}</style>
    <toolbar-active-avatar />
    <toolbar-app-list />
    <toolbar-more-menu />
  `
})

f('toolbarActiveAvatar', function () {
  useClosestStore('<a-menu>', {
    isOpen$: false,
    anchorRef$: null,
    open () { this.isOpen$(true) },
    close () { this.isOpen$(false) },
    toggle () { this.isOpen$(v => !v) }
  })

  return this.h`
    <toolbar-menu />
    <toolbar-avatar />
  `
})
f('toolbarMenu', function () {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const { session_workspaceKeys$: workspaceKeys$ } = storage
  const { order$: openWorkspaceKeys$, setOrder } = useActiveWorkspaceOrder(storage, tabStorage)
  const { close: closeMenu } = useClosestStore('<a-menu>')
  const vaultModalStore = useVaultModalStore()
  const { askVault } = useVaultActor()
  const isMobile$ = useIsMobile()

  // Track unlocking state for each user
  const unlockingUsers$ = useSignal({})
  const unlockErrors$ = useSignal({})

  const defaultUserPk$ = storage.session_defaultUserPk$
  // Get all users from workspaces (allowing duplicates)
  const allUsers$ = useComputed(() => {
    const users = []
    const userCounts = {} // Track count for each user

    // Process all workspaces to get all users (including duplicates)
    workspaceKeys$().forEach((wsKey) => {
      const userPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
      if (userPk !== undefined && userPk !== null) {
        const profile = storage[`session_accountByUserPk_${userPk}_profile$`]()
        const isLocked = storage[`session_accountByUserPk_${userPk}_isLocked$`]()
        const isReadOnly = storage[`session_accountByUserPk_${userPk}_isReadOnly$`]() ?? false

        // Initialize count for this user if not seen before
        if (userCounts[userPk] === undefined) {
          userCounts[userPk] = 0
        }

        // Increment count for this user
        userCounts[userPk]++

        users.push({
          userPk,
          wsKey,
          profile,
          name: profile?.name || profile?.npub ||
            (userPk !== defaultUserPk$() &&
              base62ToBase16(userPk, { mode: 'integer', byteLength: 32 })) ||
            t('Default User'),
          isLocked,
          isReadOnly,
          index: userCounts[userPk], // User-specific index (1-indexed)
          totalCount: userCounts[userPk] // Current count (will be final after loop)
        })
      }
    })

    // Update totalCount to the final count for each user
    const finalUserCounts = {}
    users.forEach(user => {
      if (finalUserCounts[user.userPk] === undefined) {
        finalUserCounts[user.userPk] = 0
      }
      finalUserCounts[user.userPk]++
    })

    // Update each user with the final count
    users.forEach(user => {
      user.totalCount = finalUserCounts[user.userPk]
    })

    return users
  })

  // Get current active user
  const activeUserPk$ = useComputed(() => {
    const wsKey = openWorkspaceKeys$()[0]
    return storage[`session_workspaceByKey_${wsKey}_userPk$`]()
  })

  const { disableStartAtVaultHomeWorkaroundThisTime } = useGlobalStore('vaultMessenger')
  const handleUserClick = useCallback(async (userPk, wsKey, isLocked) => {
    if (userPk !== activeUserPk$()) {
      // Switch user: move this user's workspace to the head of openWorkspaceKeys$
      const currentOpenWorkspaceKeys = [...openWorkspaceKeys$()]
      const newOpenWorkspaceKeys = [wsKey, ...currentOpenWorkspaceKeys.filter(key => key !== wsKey)]
      setOrder(newOpenWorkspaceKeys)
    }

    // If user is locked, try to unlock
    if (isLocked) {
      const userKey = `${userPk}-${wsKey}`
      unlockingUsers$({ ...unlockingUsers$(), [userKey]: true })
      unlockErrors$({ ...unlockErrors$(), [userKey]: null })

      try {
        const userPkB16 = base62ToBase16(userPk, { mode: 'integer', byteLength: 32 })
        const response = await askVault(
          { code: 'UNLOCK_ACCOUNT', payload: { pubkey: userPkB16 } },
          { timeout: 120000, instant: true }
        )

        if (response.error || !response.payload?.isRouteReady) {
          throw new Error(response.error?.message || t('Failed to unlock account'))
        }

        closeMenu()
        // cause above message makes vault navigate to unlock route
        disableStartAtVaultHomeWorkaroundThisTime()
        vaultModalStore.open()
      } catch (error) {
        // Show error message
        unlockErrors$({ ...unlockErrors$(), [userKey]: error.message || t('Error unlocking') })

        // Clear error after 3 seconds
        setTimeout(() => {
          unlockErrors$(prev => {
            const newErrors = { ...prev }
            delete newErrors[userKey]
            return newErrors
          })
        }, 3000)
      } finally {
        // Clear unlocking state
        unlockingUsers$(prev => {
          const newUnlocking = { ...prev }
          delete newUnlocking[userKey]
          return newUnlocking
        })
      }
    } else {
      closeMenu()
    }
  })

  const handleAddUserClick = useCallback(() => {
    closeMenu()
    vaultModalStore.open()
  })

  const menuStore = useClosestStore('<a-menu>')
  const menuProps = useStore({
    render: useCallback(function () {
      return this.h`<div id='user-selection-menu'>
        <style>${`
          #user-selection-menu {
            display: flex;
            flex-direction: column;
            padding: 4px;
            min-width: 200px;
            max-width: 230px;
            background-color: ${cssVars.colors.bg2};
            color: ${cssVars.colors.fg2};
            border-radius: 6px;
            box-shadow: 0 4px 12px ${cssVars.colors.shadow};
            overflow: hidden;

            .user-item {
              border-radius: 6px;
              display: flex;
              align-items: center;
              padding: 5px 8px;
              cursor: pointer;
              transition: background-color 0.2s;
            }
            .user-item.active {
              background-color: ${cssVars.colors.overlayHover};
            }
            .user-item:hover {
              background-color: ${cssVars.colors.overlaySelected};
            }
            .user-avatar {
              margin-right: 12px;
              flex-shrink: 0;
              width: 40px;
              height: 40px;
              position: relative;
            }
            .user-name {
              font-size: 15rem;
              font-weight: 600;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }
            .user-unlock-hint {
              font-size: 12rem;
              font-style: italic;
              color: ${cssVars.colors.fgMuted};
              margin-top: 2px;
            }
            .user-unlock-error {
              font-size: 12rem;
              font-style: italic;
              color: ${cssVars.colors.fgError};
              margin-top: 2px;
            }
            .user-item.unlocking {
              animation: pulsate 2s ease-in-out infinite;
            }
            @keyframes pulsate {
              0% { background-color: ${cssVars.colors.overlayHover}; }
              50% { background-color: ${cssVars.colors.overlaySelected}; }
              100% { background-color: ${cssVars.colors.overlayHover}; }
            }
            .user-index-badge {
              position: absolute;
              bottom: -2px;
              left: -2px;
              width: 16px;
              height: 16px;
              background-color: ${cssVars.colors.bgAccentSecondary};
              border-radius: 50%;
              display: flex;
              justify-content: center;
              align-items: center;
              color: ${cssVars.colors.fgAccent};
              font-size: 10px;
              font-weight: bold;
            }
            .lock-icon {
              position: absolute;
              bottom: -2px;
              right: -2px;
              width: 16px;
              height: 16px;
              background-color: ${cssVars.colors.bgAccentPrimary};
              border-radius: 50%;
              display: flex;
              justify-content: center;
              align-items: center;
              color: ${cssVars.colors.fgAccent};
            }
            .lock-icon svg {
              width: 10px;
              height: 10px;
            }
            .add-user-button {
              border-radius: 6px;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 5px 8px;
              cursor: pointer;
              transition: background-color 0.2s;
              margin-top: 4px;
              background-color: ${cssVars.colors.overlayHover};
            }
            .add-user-button:hover {
              background-color: ${cssVars.colors.overlaySelected};
            }
            .add-user-icon {
              width: 20px;
              height: 20px;
              display: flex;
              justify-content: center;
              align-items: center;
              border-radius: 50%;
              border: 2px solid ${cssVars.colors.fg3};
              color: ${cssVars.colors.fg2};
              flex-shrink: 0;
            }
            .add-user-icon svg {
              width: 12px;
              height: 12px;
            }
          }
        `}</style>
        ${allUsers$().map(user => {
          const userKey = `${user.userPk}-${user.wsKey}`
          const isUnlocking = unlockingUsers$()[userKey]
          const errorMessage = unlockErrors$()[userKey]

          return this.h({ key: userKey })`<div
            class=${{
              'user-item': true,
              active: user.userPk === activeUserPk$(),
              unlocking: isUnlocking
            }}
            onclick=${() => handleUserClick(user.userPk, user.wsKey, user.isLocked)}
          >
            <div class="user-avatar">
              <a-avatar props=${{ pk$: user.userPk, size: '32px', weight$: 'duotone', strokeWidth$: 1 }} />
              ${user.totalCount > 1
                ? this.h`<div class="user-index-badge">${user.index}</div>`
                : ''}
              ${user.isLocked
                ? this.h`<div class="lock-icon">
                    <icon-lock props=${{ size: '10px' }} />
                  </div>`
                : ''}
            </div>
            <div>
              <div class="user-name">${user.name}</div>
              ${user.isReadOnly
                ? this.h`<div class=${errorMessage ? 'user-unlock-error' : 'user-unlock-hint'}>
                    ${errorMessage || t('Read-only')}
                  </div>`
                : user.isLocked
                ? this.h`<div class=${errorMessage ? 'user-unlock-error' : 'user-unlock-hint'}>
                    ${errorMessage || (isMobile$() ? t('Tap to unlock') : t('Click to unlock'))}
                  </div>`
                : ''}
            </div>
          </div>`
        })}
        <div class="add-user-button" onclick=${handleAddUserClick}>
          <div class="add-user-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </div>
        </div>
      </div>`
    }),
    style$: () => {
      const modernCSS = `& {
        position-anchor: --toolbar-avatar-menu;
        position-area: top span-right;
        margin: 0 0 6px -5px;
        @media (orientation: landscape) {
          position-area: left span-bottom;
          margin: -5px 8px 0 0;
        }
      }`
      const fallbackCSS = `& {
        position: fixed;
        z-index: 1000;
      }`
      return CSS.supports('position-anchor', '--test') ? modernCSS : fallbackCSS
    },
    ...menuStore
  })

  return this.h`<a-menu props=${menuProps} />`
})
f('toolbarAvatar', function () {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const {
    session_accountUserPks$: accountUserPks$,
    session_defaultUserPk$: defaultUserPk$,
    session_workspaceKeys$: workspaceKeys$
  } = storage
  const { order$: openWorkspaceKeys$ } = useActiveWorkspaceOrder(storage, tabStorage)
  const firstAccountAttention$ = useGlobalSignal(FIRST_ACCOUNT_ATTENTION_SIGNAL, null)
  const { isHidden$: isToolbarHidden$ } = useGlobalStore('toolbarState', { isHidden$: false })

  const userPk$ = useComputed(() => {
    const wsKey = openWorkspaceKeys$()[0]
    return storage[`session_workspaceByKey_${wsKey}_userPk$`]()
  })

  const isLocked$ = useComputed(() => {
    const userPk = userPk$()
    return userPk ? storage[`session_accountByUserPk_${userPk}_isLocked$`]() : false
  })

  const isReadOnly$ = useComputed(() => {
    const userPk = userPk$()
    if (!userPk || userPk === defaultUserPk$()) return false
    return storage[`session_accountByUserPk_${userPk}_isReadOnly$`]() === true
  })

  const tooltipOpen$ = useSignal(false)
  const tooltipKind$ = useSignal(null)
  const isMobile$ = useIsMobile()
  const tooltipText$ = useComputed(() => {
    if (tooltipKind$() !== 'create-account') return t('Unlock your account to continue')
    return isMobile$()
      ? t('Create an account — it takes one tap')
      : t('Create an account — it takes one click')
  })

  const showFirstAccountAttention$ = useComputed(() => shouldShowFirstAccountAttention({
    attention: firstAccountAttention$(),
    activeUserPk: userPk$(),
    accountUserPks: accountUserPks$(),
    defaultUserPk: defaultUserPk$()
  }))

  // The payload expires even if this component is temporarily unmounted, so
  // a later render cannot replay an old first-account confirmation.
  useTask(({ track, cleanup }) => {
    const attention = track(() => firstAccountAttention$())
    if (!attention) return
    const timeout = setTimeout(() => {
      if (firstAccountAttention$()?.id === attention.id) {
        firstAccountAttention$(null)
      }
    }, Math.max(0, attention.expiresAt - Date.now()))
    cleanup(() => clearTimeout(timeout))
  })

  // Signer-request tooltip: only the active user's attention is rendered,
  // it stays open for the attention window, and any close path clears the
  // shared signal so the next request can reopen it.
  useTask(({ track, cleanup }) => {
    const attention = track(() => signerRequestAttention$())
    const userPk = track(() => userPk$())
    const valid = attention && attention.userPk === userPk && attention.expiresAt > Date.now()
    if (!valid) {
      tooltipOpen$(false)
      tooltipKind$(null)
      if (attention) clearSignerRequestAttention()
      return
    }
    tooltipKind$(attention.kind)

    // When the toolbar is hidden (which also entered fullscreen), reveal it
    // without exiting fullscreen and wait for its animation to finish before
    // firing the halo + tooltip, so the anchor is actually visible.
    let revealTimer
    let toolbarEl
    let onTransitionEnd
    let revealed = false
    const reveal = () => {
      if (revealed) return
      revealed = true
      tooltipOpen$(true)
    }
    if (isToolbarHidden$()) {
      isToolbarHidden$.set(false)
      toolbarEl = document.getElementById('unified-toolbar')
      onTransitionEnd = e => {
        if (e.target === toolbarEl) reveal()
      }
      toolbarEl?.addEventListener('transitionend', onTransitionEnd)
      // Fallback in case transitionend does not fire (e.g. reduced motion).
      revealTimer = setTimeout(reveal, 400)
    } else {
      reveal()
    }

    const timeout = setTimeout(() => {
      tooltipOpen$(false)
      tooltipKind$(null)
      clearSignerRequestAttention()
    }, Math.max(0, attention.expiresAt - Date.now()))
    cleanup(() => {
      clearTimeout(timeout)
      clearTimeout(revealTimer)
      if (onTransitionEnd && toolbarEl) toolbarEl.removeEventListener('transitionend', onTransitionEnd)
    })
  })

  // Calculate the user index and total count for the active user
  const userIndex$ = useComputed(() => {
    const activeUserPk = userPk$()
    const activeWsKey = openWorkspaceKeys$()[0]

    if (!activeUserPk || !activeWsKey) return { index: 1, showBadge: false }

    // Count how many times this user appears before the active workspace
    let userCount = 0
    let totalCount = 0

    // First pass: count total occurrences
    for (const wsKey of workspaceKeys$()) {
      const wsUserPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
      if (wsUserPk === activeUserPk) {
        totalCount++
      }
    }

    // Second pass: find the index of the active workspace
    for (const wsKey of workspaceKeys$()) {
      const wsUserPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
      if (wsUserPk === activeUserPk) {
        userCount++
        if (wsKey === activeWsKey) {
          break // Found the active workspace, stop counting
        }
      }
    }

    return {
      index: userCount,
      showBadge: totalCount > 1
    }
  })

  const { toggle: toggleMenu, close: closeMenu, anchorRef$ } = useClosestStore('<a-menu>')
  const vaultModalStore = useVaultModalStore()
  const isLoggedIn$ = useComputed(() => userPk$() !== storage.session_defaultUserPk$() || openWorkspaceKeys$().length > 1)
  useTask(({ track }) => {
    if (track(() => isLoggedIn$())) return
    closeMenu()
  })
  const onClick = useCallback(() => {
    tooltipOpen$(false)
    tooltipKind$(null)
    clearSignerRequestAttention()
    if (isLoggedIn$()) return toggleMenu()

    vaultModalStore.open()
  })
  const handleTooltipActivate = useCallback(() => {
    tooltipOpen$(false)
    tooltipKind$(null)
    clearSignerRequestAttention()
    closeMenu()
    vaultModalStore.open()
  })

  return this.h`<div style="position: relative; display: inline-block;">
    <div
      id='toolbar-active-avatar-button'
      class=${{
        'first-account-attention': showFirstAccountAttention$(),
        'signer-request-attention': tooltipOpen$()
      }}
      ref=${anchorRef$}
      onclick=${onClick}
      aria-describedby=${tooltipOpen$() ? 'signer-request-tooltip' : null}
      style=${`
        anchor-name: --toolbar-avatar-menu;
        color: ${cssVars.colors.fg2};
        width: 40px; height: 40px; display: flex; justify-content: center; align-items: center;
        border-radius: 50%;
        position: relative;
        cursor: pointer;
      `}
    >
      <style>${`
        #toolbar-active-avatar-button.first-account-attention::before,
        #toolbar-active-avatar-button.first-account-attention::after,
        #toolbar-active-avatar-button.signer-request-attention::before,
        #toolbar-active-avatar-button.signer-request-attention::after {
          content: '';
          position: absolute;
          inset: 4px;
          border: 2px solid ${cssVars.colors.bgAccentPrimary};
          border-radius: 50%;
          opacity: 0;
          pointer-events: none;
          animation: toolbar-first-account-halo 1.4s ease-out both;
        }

        #toolbar-active-avatar-button.first-account-attention::after,
        #toolbar-active-avatar-button.signer-request-attention::after {
          animation-delay: 550ms;
        }

        @keyframes toolbar-first-account-halo {
          0% {
            opacity: 0;
            transform: scale(.94);
          }
          15% {
            opacity: .75;
          }
          100% {
            opacity: 0;
            transform: scale(1.45);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          #toolbar-active-avatar-button.first-account-attention::before,
          #toolbar-active-avatar-button.signer-request-attention::before {
            animation: toolbar-first-account-outline 1.95s ease-out both;
          }
          #toolbar-active-avatar-button.first-account-attention::after,
          #toolbar-active-avatar-button.signer-request-attention::after {
            display: none;
            animation: none;
          }
        }

        @keyframes toolbar-first-account-outline {
          0%, 70% {
            opacity: .75;
            transform: scale(1);
          }
          100% {
            opacity: 0;
            transform: scale(1);
          }
        }
      `}</style>
      <a-avatar props=${{ pk$: userPk$, size: '32px', weight$: 'duotone', strokeWidth$: 1 }} />
      ${isReadOnly$()
        ? this.h`<div style=${`
            position: absolute;
            inset: 0;
            border-radius: 50%;
            background-color: ${cssVars.colors.overlaySelected};
            display: flex;
            align-items: center;
            justify-content: center;
            color: ${cssVars.colors.fg2};
          `}>
            <icon-pencil-off props=${{ size: '16px' }} />
          </div>`
        : ''}
      ${userIndex$().showBadge
        ? this.h`<div style=${`
            position: absolute;
            bottom: -2px;
            left: -2px;
            width: 16px;
            height: 16px;
            background-color: ${cssVars.colors.bgAccentSecondary};
            border-radius: 50%;
            display: flex;
            justify-content: center;
            align-items: center;
            color: ${cssVars.colors.fgAccent};
            font-size: 10px;
            font-weight: bold;
          `}>
            ${userIndex$().index}
          </div>`
        : ''}
      ${isLocked$()
        ? this.h`<div style=${`
            position: absolute;
            bottom: -2px;
            right: -2px;
            width: 16px;
            height: 16px;
            background-color: ${cssVars.colors.bgAccentPrimary};
            border-radius: 50%;
            display: flex;
            justify-content: center;
            align-items: center;
            color: ${cssVars.colors.fgAccent};
          `}>
            <icon-lock props=${{ size: '10px' }} />
          </div>`
        : ''}
    </div>
    <signer-request-tooltip props=${{
      open$: tooltipOpen$,
      text$: tooltipText$,
      anchorRef$,
      onActivate: handleTooltipActivate
    }} />
  </div>`
})

f('toolbarAppList', function () {
  useClosestStore('<a-menu>', () => ({
    isOpenedByLongPress: false,
    isOpen$: false,
    open () { this.isOpen$(true) },
    close () { this.isOpen$(false) },
    app$: { key: '' },
    toggleMenu (nextApp) {
      const isSameApp = this.app$().key === nextApp.key
      if (isSameApp) {
        this.app$(nextApp)
        this.isOpen$(v => !v)
      } else {
        this.close()
        window.queueMicrotask(() => {
          this.app$(nextApp)
          this.open()
        })
      }
    }
  }), { isStatic: false })

  // Soften the hard clipping at the app list edges: while content is cut at
  // the start or end edge, toggle a mask that fades those edges out. The
  // mask is anchored to the container, so the fade stays put while scrolling.
  useTask(({ cleanup }) => {
    const el = this
    const updateEdgeFades = () => {
      const isLandscape = window.matchMedia('(orientation: landscape)').matches
      const canScrollStart = isLandscape
        ? el.scrollTop > 0
        : el.scrollLeft > 0
      const canScrollEnd = isLandscape
        ? el.scrollTop + el.clientHeight < el.scrollHeight - 1
        : el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      el.classList.toggle('fade-start', canScrollStart)
      el.classList.toggle('fade-end', canScrollEnd)
    }
    updateEdgeFades()
    el.addEventListener('scroll', updateEdgeFades, { passive: true })
    const resizeObserver = new ResizeObserver(updateEdgeFades)
    resizeObserver.observe(el)
    cleanup(() => {
      el.removeEventListener('scroll', updateEdgeFades)
      resizeObserver.disconnect()
    })
  }, { after: 'rendering' })

  return this.h`
    <other-users-app-groups />
    <toolbar-pinned-apps />
    <toolbar-unpinned-apps />
  `
})
f('toolbarPinnedApps', function () {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const { order$: openWorkspaceKeys$ } = useActiveWorkspaceOrder(storage, tabStorage)
  const appIdsdKeysIndexes$ = useComputed(() => {
    const wsKey = openWorkspaceKeys$()[0]
    const pinnedAppIds = storage[`session_workspaceByKey_${wsKey}_pinnedAppIds$`]() || []
    return pinnedAppIds.reduce((r, appId, i) => {
      const appIndex = i + 1
      storage[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]().forEach(appKey => { r.push({ appId, appKey, appIndex }) })
      return r
    }, [])
  })

  // Due to f/uhtml renderer limitation, inserting/removing new keyed children
  // needs a static anchor node, that's why the invisible anchor
  // `<div style="display: contents"></div>` was added
  return this.h`
    <div style="display: contents"></div>
    ${appIdsdKeysIndexes$().map(v => this.h({ key: v.appKey })`<toolbar-app-launcher key=${v.appKey} props=${v} />`)}
  `
})
f('toolbarUnpinnedApps', function () {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const { order$: openWorkspaceKeys$ } = useActiveWorkspaceOrder(storage, tabStorage)
  const isGroupPopoverOpen$ = useComputed(() => otherUsersGroupPopoverOpen$())
  const appIdsdKeysIndexes$ = useComputed(() => {
    const wsKey = openWorkspaceKeys$()[0]
    const pinnedAppIdsLength = (storage[`session_workspaceByKey_${wsKey}_pinnedAppIds$`]() || []).length
    const unpinnedAppIds = storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`]() || []
    return unpinnedAppIds.reduce((r, appId, i) => {
      const appIndex = i + 1 + pinnedAppIdsLength
      storage[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]().forEach(appKey => { r.push({ appId, appKey, appIndex }) })
      return r
    }, [])
  })

  return this.h`
    ${isGroupPopoverOpen$() ? '' : this.h`<app-launchers-menu />`}
    ${appIdsdKeysIndexes$().map(v => this.h({ key: v.appKey })`<toolbar-app-launcher key=${v.appKey} props=${v} />`)}
  `
})
f('appLaunchersMenu', function () {
  const store = useClosestStore('<a-menu>')
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const createRequest$ = useGlobalSignal('widgetsCreateRequest', null)
  const widgetsRevealActive$ = useGlobalSignal('widgetsRevealActive', false)
  const { requestConfirmation } = useConfirmationDialogStore()
  const { openNewAppInstance } = useGlobalStore('useAppRouter')
  const menuProps = useStore(() => ({
    ...store,
    copiedAppKey$: null,
    openApp () {
      const { visibility, key: appKey, workspaceKey } = this.app$()
      if (visibility === 'open') throw new Error('App is already open')

      this.close() // close menu
      tabStorage[`session_appByKey_${appKey}_visibility$`]('open')
      tabStorage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]((v = [], eqKey) => {
        const i = v.indexOf(appKey)
        if (i !== -1) v.splice(i, 1) // remove
        v.unshift(appKey) // place at beginning
        v[eqKey] = Math.random()
        return v
      })
    },
    bringToFirst () {
      const { visibility, key: appKey, workspaceKey } = this.app$()
      const openAppKeys = tabStorage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]() ?? []
      if (visibility !== 'open') throw new Error('Can only bring to first when app is open')
      if (openAppKeys[0] === appKey) throw new Error('App is already first')

      this.close() // close menu
      let i
      tabStorage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]((v, eqKey) => {
        i = v.indexOf(appKey)
        if (i > -1) {
          v.splice(i, 1) // remove
          v.unshift(appKey) // place at beginning
          v[eqKey] = Math.random()
        }
        return v
      })
    },
    minimizeApp () {
      const { visibility, key: appKey, workspaceKey } = this.app$()
      if (visibility !== 'open') throw new Error('Can only minimize an open app')

      this.close() // close menu
      let i
      tabStorage[`session_appByKey_${appKey}_visibility$`]('minimized')
      tabStorage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]((v, eqKey) => {
        i = v.indexOf(appKey)
        if (i > -1) {
          v.splice(i, 1) // remove (to e.g. let 3rd app become 2nd)
          v[eqKey] = Math.random()
        }
        return v
      })
    },
    newWindow () {
      const { id: appId, visibility, workspaceKey } = this.app$()
      if (visibility === 'closed') throw new Error('Can only open a new window for an open or minimized app')

      this.close() // close menu
      openNewAppInstance(appId, workspaceKey)
    },
    shareApp () {
      const { id: appId, key: appKey } = this.app$()
      const appName = storage[`session_appById_${appId}_name$`]()
      const napp = appEncode({ ...appIdToAddressObj(appId), relays: [] })
      const url = new URL(`/${napp}`, window.location.origin).href
      const shareData = { title: appName || '44billion', url }
      const canShare = typeof navigator.share === 'function'

      const share = async () => {
        if (canShare) {
          try {
            await navigator.share(shareData)
            this.close()
            return
          } catch (error) {
            if (error?.name === 'AbortError') {
              this.close()
              return
            }
          }
        }

        await copyTextToClipboard(url)
        this.copiedAppKey$(appKey)
        setTimeout(() => {
          if (this.copiedAppKey$() === appKey) this.copiedAppKey$(null)
          this.close()
        }, 1600)
      }

      share().catch(error => {
        if (error?.name !== 'AbortError') console.error('Failed to share app:', error)
      })
    },
    closeApp () {
      const { visibility, key: appKey, workspaceKey } = this.app$()
      if (visibility === 'closed') throw new Error('App is already closed')

      this.close() // close menu
      tabStorage[`session_appByKey_${appKey}_visibility$`]('closed')
      tabStorage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]((v, eqKey) => {
        const i = v.indexOf(appKey)
        if (i !== -1) {
          v.splice(i, 1) // remove
          v[eqKey] = Math.random()
        }
        return v
      })
    },
    removeApp () {
      const { id: appId, key: appKey, workspaceKey } = this.app$()
      const appKeys = storage[`session_workspaceByKey_${workspaceKey}_appById_${appId}_appKeys$`]()
      if (!appKeys) throw new Error('Cannot remove app instance: app state is missing')
      if (appKeys.length <= 1) throw new Error('Cannot remove the last instance of an app')
      this.close() // close menu
      return removeAppFromWorkspace({
        storage,
        tabStorage,
        wsKey: workspaceKey,
        appKey,
        appId,
        userPk: storage[`session_workspaceByKey_${workspaceKey}_userPk$`]()
      })
    },
    addWidget () {
      const { id: appId, key: appKey, workspaceKey } = this.app$()
      const pinnedRoute = storage[`session_appByKey_${appKey}_route$`]() || ''
      this.close() // close menu
      createRequest$({
        appId,
        wsKey: workspaceKey,
        pinnedRoute
      })
      // If open app windows would cover the new widget, enter the reveal mode
      // (windows fade out, toolbar grays out) until the toolbar is clicked.
      const openAppKeys = tabStorage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]() ?? []
      const hasOpenWindow = openAppKeys.some(openKey =>
        tabStorage[`session_appByKey_${openKey}_visibility$`]() === 'open'
      )
      if (hasOpenWindow) widgetsRevealActive$(true)
    },
    async deleteApp () {
      try {
        await requestConfirmation({
          confirmText: t('Delete')
        })
      } catch (err) { if (err.code !== 'DENIED_BY_USER') console.error(err); return }
      await this._deleteApp()
    },
    async _deleteApp () {
      const { id: appId, workspaceKey } = this.app$()
      const appKeys = storage[`session_workspaceByKey_${workspaceKey}_appById_${appId}_appKeys$`]()
      if (!appKeys) throw new Error('Cannot delete app: app state is missing')
      if (appKeys.length !== 1) throw new Error('Can only delete an app that has a single instance')
      const appKey = appKeys[0]
      const preserveAppMetadata = await hasAnyRecentSingleNappOpen({ appId })
      await uninstallAppFromWorkspace({
        storage,
        tabStorage,
        wsKey: workspaceKey,
        appKey,
        appId,
        userPk: storage[`session_workspaceByKey_${workspaceKey}_userPk$`](),
        preserveAppMetadata
      })

      this.close() // close menu
    },
    render: useCallback(function () {
      const {
        openApp,
        bringToFirst,
        newWindow,
        addWidget,
        minimizeApp,
        closeApp,
        removeApp,
        deleteApp,
        shareApp,
        copiedAppKey$,
        app$
      } = menuProps
      const {
        id: appId,
        key: appKey,
        visibility,
        workspaceKey
      } = app$()
      const openAppKeys = tabStorage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]() ?? []
      const appKeys = storage[`session_workspaceByKey_${workspaceKey}_appById_${appId}_appKeys$`]()
      const canShare = typeof navigator.share === 'function'
      const shareLabel = canShare ? t('Share') : t('Copy link')
      return this.h`<div id='scope_pfgf892'>
        <style>${`
          #scope_pfgf892 {
            & > div {
              &.invisible { display: none; }
              display: flex;
              align-items: center;
              cursor: pointer;
            }
            .icon-wrapper-271yiduh {
              flex: 0 1 min-content;
              margin: 10px;
            }
            .menu-label {
              flex: 1;
              min-height: 30px;
              padding: 10px 10px 10px 3px;
            }
            .share-label {
              display: grid;
              width: max-content;
            }
            .share-label > span {
              grid-area: 1 / 1;
            }
            .share-label > .share-label-hidden {
              visibility: hidden;
            }
          }
        `}</style>
        <div class=${{ invisible: visibility === 'open' }}>
          <div class='icon-wrapper-271yiduh'><icon-maximize props=${{ size: '16px' }} /></div>
          <div class='menu-label' onclick=${openApp}>${visibility === 'closed' ? t('Open') : t('Maximize')}</div>
        </div>
        <div class=${{ invisible: visibility !== 'open' || openAppKeys[0] === appKey }}>
          <div class='icon-wrapper-271yiduh'><icon-stack-front props=${{ size: '16px' }} /></div>
          <div class='menu-label' onclick=${bringToFirst}>${t('Bring to First')}</div>
        </div>
        <div class=${{ invisible: visibility === 'closed' }}>
          <div class='icon-wrapper-271yiduh'><icon-library-plus props=${{ size: '16px' }} /></div>
          <div class='menu-label' onclick=${newWindow}>${t('New Window')}</div>
        </div>
        <div class=${{ invisible: appKeys.length <= 1 }}>
          <div class='icon-wrapper-271yiduh'><icon-remove props=${{ size: '16px' }} /></div>
          <div class='menu-label' onclick=${removeApp}>${t('Remove Window')}</div>
        </div>
        <div>
          <div class='icon-wrapper-271yiduh'><icon-wash-dry-shade props=${{ size: '16px' }} /></div>
          <div
            class='menu-label'
            role='button'
            aria-label=${t('Add Widget')}
            onclick=${addWidget}
          >${getEffectiveLocale() === 'en' ? t('Add Widget') : t('Add Widget (short)')}</div>
        </div>
        <div class=${{ invisible: visibility !== 'open' }}>
          <div class='icon-wrapper-271yiduh'><icon-minimize props=${{ size: '16px' }} /></div>
          <div class='menu-label' onclick=${minimizeApp}>${t('Minimize')}</div>
        </div>
        <div class=${{ invisible: visibility === 'closed' }}>
          <div class='icon-wrapper-271yiduh'><icon-close props=${{ size: '16px' }} /></div>
          <div class='menu-label' onclick=${closeApp}>${t('Close')}</div>
        </div>
        <div class=${{ invisible: appKeys.length !== 1 }}>
          <div class='icon-wrapper-271yiduh'><icon-delete props=${{ size: '16px' }} /></div>
          <div class='menu-label' onclick=${deleteApp}>${t('Delete')}</div>
        </div>
        <div>
          <div class='icon-wrapper-271yiduh'>
            ${canShare ? this.h`<icon-share-2 props=${{ size: '16px' }} />` : this.h`<icon-copy props=${{ size: '16px' }} />`}
          </div>
          <div class='menu-label' onclick=${shareApp}>
            <span class='share-label'>
              <span class=${copiedAppKey$() === appKey ? 'share-label-hidden' : ''}>${shareLabel}</span>
              <span class=${copiedAppKey$() === appKey ? '' : 'share-label-hidden'}>${t('Copied!')}</span>
            </span>
          </div>
        </div>
      </div>`
    }),
    style$: () => {
      const modernCSS = `& {
        position-anchor: --app-launchers-menu;
        position-area: top span-right;
        margin-bottom: 6px;
        @media (orientation: landscape) {
          position-area: left span-bottom;
          margin-right: 7px;
        }
      }`
      const fallbackCSS = `& {
        position: fixed;
        z-index: 1000;
      }`
      const commonCSS = `
        background-color: ${cssVars.colors.bg2};
        color: ${cssVars.colors.fg2};
        min-width: 120px;
        display: flex;
        flex-direction: column;
      `

      const anchorCSS = CSS.supports('position-anchor', '--test') ? modernCSS : fallbackCSS
      return `& { ${anchorCSS} ${commonCSS} }`
    },
    anchorRef$: () => menuProps.app$()?.ref
  }))
  return this.h`<a-menu props=${menuProps} />`
})
f('toolbarAppLauncher', function () {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const { order$: activeWsOrder$ } = useActiveWorkspaceOrder(storage, tabStorage)
  const { isSystemRoute$, closeSystemViews } = useSystemRouter()
  const widgetsRevealActive$ = useGlobalSignal('widgetsRevealActive', false)
  const newAppIdsObj$ = useGlobalSignal('hardcoded_newAppIdsObj')
  const appIndex$ = useStateSignal(this.props.appIndex)
  const appRef$ = useSignal()
  const workspaceKey = this.props.workspaceKey || activeWsOrder$()[0]

  const app$ = useComputed(() => ({
    id: this.props.appId,
    key: this.props.appKey,
    workspaceKey,
    index: appIndex$(),
    visibility: tabStorage[`session_appByKey_${this.props.appKey}_visibility$`]() ?? 'closed',
    icon: storage[`session_appById_${this.props.appId}_icon$`](),
    isNew: !!newAppIdsObj$()[this.props.appId],
    ref: appRef$()
  }))

  // const unifiedToolbarRef$ = useClosestSignal('unifiedToolbarRef')
  // useLongPress(unifiedToolbarRef$, appRef$)
  const { toggleMenu, app$: currApp$ } = useClosestStore('<a-menu>')
  const handleClick = () => {
    if (widgetsRevealActive$()) {
      widgetsRevealActive$(false)
      return
    }
    if (isSystemRoute$()) {
      closeSystemViews()
      return
    }

    toggleMenu({ ...app$() })
  }
  const anchorName$ = useComputed(() => currApp$().key === app$().key ? '--app-launchers-menu' : 'none')

  // const onClick = useCallback(e => {
  //   // canceled by longpress
  //   if (e.shouldStopPropagation) return

  //   switch (app$().visibility) {
  //     case 'closed': {
  //       // open
  //       storage[`session_appByKey_${app$().key}_visibility$`]('open')
  //       storage[`session_workspaceByKey_${app$().workspaceKey}_openAppKeys$`]((v, eqKey) => {
  //         const appKey = app$().key
  //         const i = v.indexOf(appKey)
  //         if (i !== -1) v.splice(i, 1) // remove
  //         v.unshift(appKey) // place at beginning
  //         v[eqKey] = Math.random()
  //         return v
  //       })
  //       break
  //     }
  //     case 'minimized': {
  //       // maximize
  //       const appKey = app$().key
  //       storage[`session_appByKey_${appKey}_visibility$`]('open')
  //       storage[`session_workspaceByKey_${app$().workspaceKey}_openAppKeys$`]((v, eqKey) => {
  //         const i = v.indexOf(appKey)
  //         if (i !== -1) v.splice(i, 1) // remove
  //         v.unshift(appKey) // place at beginning
  //         v[eqKey] = Math.random()
  //         return v
  //       })
  //       break
  //     }
  //     case 'open': {
  //       // bring to front or minimize
  //       const appKey = app$().key
  //       storage[`session_workspaceByKey_${app$().workspaceKey}_openAppKeys$`]((v, eqKey) => {
  //         const i = v.indexOf(appKey)
  //         if (i > -1) {
  //           v.splice(i, 1) // remove (to e.g. let 3rd app become 2nd)
  //           if (i === 0) storage[`session_appByKey_${appKey}_visibility$`]('minimized')
  //           else v.unshift(appKey) // place at beginning
  //           v[eqKey] = Math.random()
  //         }
  //         return v
  //       })
  //       break
  //     }
  //   }
  // })

  const squircleColor$ = useComputed(() => {
    const visibility = app$().visibility
    switch (visibility) {
      case 'open':
        return cssVars.colors.bg3Primary
      case 'minimized':
        return cssVars.colors.bg3Secondary
      case 'closed':
      default:
        return cssVars.colors.bg3
    }
  })

  // @custom:longpress=${onLongPress}
  return this.h`<div
    ref=${appRef$}
    onclick=${handleClick}
    id=${`scope_df81hd_${app$().key}`}
    style=${`
      anchor-name: ${anchorName$()};
      background-color: transparent;
      width: 40px;
      height: 40px;
      display: flex;
      justify-content: center;
      align-items: center;
      position: relative;
    `}
  >
    <style>${`
      #scope_df81hd_${app$().key} {
        & {
          flex-shrink: 0;
        }
        .squircle {
          position: absolute;
          width: 100%;
          height: 100%;
          z-index: 0;

          path {
            fill: ${squircleColor$()};
            stroke: none;
          }
        }
      }
    `}</style>
    ${this.s`<svg viewbox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" class="squircle">
      <path d="M 0, 100 C 0, 12 12, 0 100, 0 S 200, 12 200, 100 188, 200 100, 200 0, 188 0, 100"></path>
    </svg>`}
    <div style=${`
      width: 32px; height: 32px; z-index: 1; cursor: pointer;
      overflow: hidden;
      border-radius: 10px;
      background-color: ${cssVars.colors.bgAvatar};
      color: ${cssVars.colors.fg3};
    `}>
      <app-icon props=${{
        app$
      }} />
    </div>
  </div>`
})

function getLocales () {
  return {
    'Default User': { en: 'Default User', fr: 'Utilisateur par défaut', it: 'Utente predefinito', de: 'Standardbenutzer', es: 'Usuario predeterminado', 'pt-BR': 'Usuário padrão', ru: 'Пользователь по умолчанию', 'zh-CN': '默认用户', 'zh-TW': '預設使用者', ja: 'デフォルトユーザー', ko: '기본 사용자' },
    'Failed to unlock account': { en: 'Failed to unlock account', fr: 'Impossible de déverrouiller le compte', it: 'Impossibile sbloccare l’account', de: 'Konto konnte nicht entsperrt werden', es: 'No se pudo desbloquear la cuenta', 'pt-BR': 'Falha ao desbloquear a conta', ru: 'Не удалось разблокировать учётную запись', 'zh-CN': '无法解锁账户', 'zh-TW': '無法解鎖帳號', ja: 'アカウントのロックを解除できませんでした', ko: '계정 잠금을 해제하지 못했습니다' },
    'Error unlocking': { en: 'Error unlocking', fr: 'Erreur de déverrouillage', it: 'Errore durante lo sblocco', de: 'Fehler beim Entsperren', es: 'Error al desbloquear', 'pt-BR': 'Erro ao desbloquear', ru: 'Ошибка разблокировки', 'zh-CN': '解锁时出错', 'zh-TW': '解鎖時發生錯誤', ja: 'ロック解除エラー', ko: '잠금 해제 오류' },
    'Click to unlock': { en: 'Click to unlock', fr: 'Cliquez pour déverrouiller', it: 'Clicca per sbloccare', de: 'Zum Entsperren klicken', es: 'Haz clic para desbloquear', 'pt-BR': 'Clique para desbloquear', ru: 'Кликните, чтобы разблокировать', 'zh-CN': '点击以解锁', 'zh-TW': '點擊以解鎖', ja: 'クリックしてロック解除', ko: '클릭하여 잠금 해제' },
    'Tap to unlock': { en: 'Tap to unlock', fr: 'Appuyez pour déverrouiller', it: 'Tocca per sbloccare', de: 'Zum Entsperren tippen', es: 'Toca para desbloquear', 'pt-BR': 'Toque para desbloquear', ru: 'Коснитесь, чтобы разблокировать', 'zh-CN': '轻触以解锁', 'zh-TW': '輕觸以解鎖', ja: 'タップしてロック解除', ko: '탭하여 잠금 해제' },
    'Read-only': { en: 'Read-only', fr: 'Lecture seule', it: 'Sola lettura', de: 'Nur lesen', es: 'Solo lectura', 'pt-BR': 'Somente leitura', ru: 'Только чтение', 'zh-CN': '只读', 'zh-TW': '唯讀', ja: '読み取り専用', ko: '읽기 전용' },
    'Create an account — it takes one click': { en: 'Create an account — it takes one click', fr: 'Créez un compte — cela ne prend qu’un clic', it: 'Crea un account — basta un clic', de: 'Konto erstellen — dauert nur einen Klick', es: 'Crea una cuenta — solo un clic', 'pt-BR': 'Crie uma conta — basta um clique', ru: 'Создайте аккаунт — это один клик', 'zh-CN': '创建账户——只需一次点击', 'zh-TW': '建立帳戶——只需一次點擊', ja: 'アカウント作成 — ワンクリックで完了', ko: '계정 만들기 — 클릭 한 번이면 끝' },
    'Create an account — it takes one tap': { en: 'Create an account — it takes one tap', fr: 'Créez un compte — cela ne prend qu’un appui', it: 'Crea un account — basta un tocco', de: 'Konto erstellen — dauert nur einen Tipp', es: 'Crea una cuenta — solo un toque', 'pt-BR': 'Crie uma conta — basta um toque', ru: 'Создайте аккаунт — это одно касание', 'zh-CN': '创建账户——只需轻点一次', 'zh-TW': '建立帳戶——只需輕觸一次', ja: 'アカウント作成 — タップ1回で完了', ko: '계정 만들기 — 탭 한 번이면 끝' },
    'Unlock your account to continue': { en: 'Unlock your account to continue', fr: 'Déverrouillez votre compte pour continuer', it: 'Sblocca il tuo account per continuare', de: 'Entsperren Sie Ihr Konto, um fortzufahren', es: 'Desbloquea tu cuenta para continuar', 'pt-BR': 'Desbloqueie sua conta para continuar', ru: 'Разблокируйте аккаунт, чтобы продолжить', 'zh-CN': '解锁您的账户以继续', 'zh-TW': '解鎖您的帳號以繼續', ja: '続行するにはアカウントのロックを解除してください', ko: '계속하려면 계정 잠금을 해제하세요' },
    'Please open an app': { en: 'Please open an app', fr: 'Veuillez ouvrir une application', it: 'Apri un’app', de: 'Bitte eine App öffnen', es: 'Abre una aplicación', 'pt-BR': 'Abra um app', ru: 'Откройте приложение', 'zh-CN': '请打开一个应用', 'zh-TW': '請開啟一個應用程式', ja: 'アプリを開いてください', ko: '앱을 열어 주세요' },
    'Opening app...': { en: 'Opening app...', fr: 'Ouverture de l’application...', it: 'Apertura dell’app...', de: 'App wird geöffnet...', es: 'Abriendo la aplicación...', 'pt-BR': 'Abrindo o app...', ru: 'Открытие приложения...', 'zh-CN': '正在打开应用...', 'zh-TW': '正在開啟應用程式...', ja: 'アプリを開いています…', ko: '앱을 여는 중...' },
    Open: { en: 'Open', fr: 'Ouvrir', it: 'Apri', de: 'Öffnen', es: 'Abrir', 'pt-BR': 'Abrir', ru: 'Открыть', 'zh-CN': '打开', 'zh-TW': '開啟', ja: '開く', ko: '열기' },
    'New Window': { en: 'New Window', fr: 'Nouvelle fenêtre', it: 'Nuova finestra', de: 'Neues Fenster', es: 'Nueva ventana', 'pt-BR': 'Nova Janela', ru: 'Новое окно', 'zh-CN': '新建窗口', 'zh-TW': '新視窗', ja: '新しいウィンドウ', ko: '새 창' },
    Share: { en: 'Share', fr: 'Partager', it: 'Condividi', de: 'Teilen', es: 'Compartir', 'pt-BR': 'Compartilhar', ru: 'Поделиться', 'zh-CN': '分享', 'zh-TW': '分享', ja: '共有', ko: '공유' },
    'Copy link': { en: 'Copy link', fr: 'Copier le lien', it: 'Copia link', de: 'Link kopieren', es: 'Copiar enlace', 'pt-BR': 'Copiar link', ru: 'Скопировать ссылку', 'zh-CN': '复制链接', 'zh-TW': '複製連結', ja: 'リンクをコピー', ko: '링크 복사' },
    'Copied!': { en: 'Copied!', fr: 'Copié !', it: 'Copiato!', de: 'Kopiert!', es: '¡Copiado!', 'pt-BR': 'Copiado!', ru: 'Скопировано!', 'zh-CN': '已复制！', 'zh-TW': '已複製！', ja: 'コピーしました！', ko: '복사됨!' },
    Maximize: { en: 'Maximize', fr: 'Agrandir', it: 'Ingrandisci', de: 'Maximieren', es: 'Maximizar', 'pt-BR': 'Maximizar', ru: 'Развернуть', 'zh-CN': '最大化', 'zh-TW': '最大化', ja: '最大化', ko: '최대화' },
    'Bring to First': { en: 'Bring to First', fr: 'Mettre au premier plan', it: 'Porta in primo piano', de: 'In den Vordergrund', es: 'Traer al frente', 'pt-BR': 'Trazer para frente', ru: 'На передний план', 'zh-CN': '置于最前', 'zh-TW': '移至最前', ja: '最前面に移動', ko: '맨 앞으로 가져오기' },
    Minimize: { en: 'Minimize', fr: 'Réduire', it: 'Riduci', de: 'Minimieren', es: 'Minimizar', 'pt-BR': 'Minimizar', ru: 'Свернуть', 'zh-CN': '最小化', 'zh-TW': '最小化', ja: '最小化', ko: '최소화' },
    Close: { en: 'Close', fr: 'Fermer', it: 'Chiudi', de: 'Schließen', es: 'Cerrar', 'pt-BR': 'Fechar', ru: 'Закрыть', 'zh-CN': '关闭', 'zh-TW': '關閉', ja: '閉じる', ko: '닫기' },
    'Remove Window': { en: 'Remove Window', fr: 'Retirer la fenêtre', it: 'Rimuovi finestra', de: 'Fenster entfernen', es: 'Quitar ventana', 'pt-BR': 'Remover Janela', ru: 'Убрать окно', 'zh-CN': '移除窗口', 'zh-TW': '移除視窗', ja: 'ウィンドウを取り除く', ko: '창 제거' },
    'Add Widget': { en: 'Add Widget', fr: 'Ajouter un widget', it: 'Aggiungi widget', de: 'Widget hinzufügen', es: 'Añadir widget', 'pt-BR': 'Adicionar Widget', ru: 'Добавить виджет', 'zh-CN': '添加小组件', 'zh-TW': '新增小工具', ja: 'ウィジェットを追加', ko: '위젯 추가' },
    'Add Widget (short)': { en: 'Add Widget (short)', fr: 'Ajouter un widget', it: 'Aggiungi widget', de: 'Widget hinzuf.', es: 'Añadir widget', 'pt-BR': 'Adic. Widget', ru: 'Добавить виджет', 'zh-CN': '添加小组件', 'zh-TW': '新增小工具', ja: 'ウィジェットを追加', ko: '위젯 추가' },
    Delete: { en: 'Delete', fr: 'Supprimer', it: 'Elimina', de: 'Löschen', es: 'Eliminar', 'pt-BR': 'Excluir', ru: 'Удалить', 'zh-CN': '删除', 'zh-TW': '刪除', ja: '削除', ko: '삭제' }
  }
}
