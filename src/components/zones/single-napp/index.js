import { f, useClosestStore, useSignal, useTask, useComputed } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import { appDecode } from 'libp2r2p/nip19'
import { addressObjToAppId } from '#helpers/app.js'
import { base62ToBase36 } from '#helpers/base36.js'
import { initMessageListener } from '#helpers/window-message/browser/index.js'
import { allocateAppSubdomain } from '#helpers/subdomain-mapping.js'
import { resetDraftAppRuntimeData } from '#zones/screen/helpers/draft-app-runtime-reset.js'
import AppUpdater from '#services/app-updater/index.js'
import { formatAssetBudgetBytes } from '#services/app-asset-budget/index.js'
import { useVaultModalStore, useVaultActor } from '#zones/vault-modal/index.js'
import { useConfirmationDialogStore } from '#zones/confirmation-dialog/index.js'
import '#shared/napp-assets-caching-progress-bar.js'

f('singleNapp', function () {
  const storage = useWebStorage(localStorage)
  const {
    session_openWorkspaceKeys$: openWorkspaceKeys$
  } = storage
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
  const userPkB36$ = useComputed(() => base62ToBase36(userPk$(), 50))
  const appSubdomain$ = useComputed(() => {
    const userPk = userPk$()
    if (!userPk) return null
    return storage[`session_subdomainByUserAndApp_${userPk}_${appId}$`]()
  })
  const trustedAppIframeRef$ = useSignal()
  const trustedAppIframeSrc$ = useSignal('about:blank')
  const appIframeRef$ = useSignal()
  const appIframeSrc$ = useSignal('about:blank')
  const launchError$ = useSignal(null)
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

  useTask(
    async ({ cleanup }) => {
      launchError$(null)
      const activeSession = AppUpdater.tryMarkSingleNappOpen(appId)
      if (!activeSession.accepted) {
        launchError$('Too many embedded apps are open. Close one and try again.')
        return
      }
      cleanup(() => activeSession.release())

      // Allocate numeric subdomain if needed
      if (appSubdomain$() == null) {
        allocateAppSubdomain(storage, { userPk: userPk$(), appId })
      }

      const ac = new AbortController()
      cleanup(() => {
        ac.abort()
      })

      let isDraftReloading = false
      const offDraftUpdate = AppUpdater.onDraftAppUpdated(async ({ appId: updatedAppId }) => {
        if (ac.signal.aborted || updatedAppId !== appId || isDraftReloading) return
        const appSubdomain = appSubdomain$()
        if (appSubdomain == null) return

        isDraftReloading = true
        try {
          await resetDraftAppRuntimeData({
            appId: updatedAppId,
            userPk: userPk$(),
            appSubdomain
          })
          if (ac.signal.aborted) return

          try {
            appIframeRef$()?.contentWindow?.location?.reload()
          } catch (_err) {
            appIframeSrc$('about:blank')
            await new Promise(resolve => setTimeout(resolve, 0))
            if (!ac.signal.aborted) appIframeSrc$(`//${appSubdomain}.${window.location.host}/`)
          }
        } finally {
          isDraftReloading = false
        }
      })
      cleanup(offDraftUpdate)

      await initMessageListener(
        userPkB36$(), appId, appSubdomain$(), initialRoute,
        trustedAppIframeRef$(), appIframeRef$(), appIframeSrc$,
        cachingProgress$, askVault, function requestPermission () {
          throw new Error('Permission request not available in single napp mode yet')
        }, function openApp () {
          throw new Error('Open app not available in single napp mode yet')
        },
        {
          signal: ac.signal,
          isSingleNapp: true,
          requestAssetBudgetConfirmation: ({ nextApprovedBytes, filename }) => requestConfirmation({
            title: 'More app storage?',
            message: `${filename ? `${filename} needs` : 'This app needs'} more cached storage. Allow this app's assets up to ${formatAssetBudgetBytes(nextApprovedBytes)}?`,
            confirmText: `Allow ${formatAssetBudgetBytes(nextApprovedBytes)}`
          })
        }
      )
      trustedAppIframeSrc$(`//${appSubdomain$()}.${window.location.host}/~~napp`)
    },
    { after: 'rendering' }
  )

  return this.h`
      <style>
        single-napp-launcher {
          position: relative;
          display: block;
          width: 100%;
          height: 100%;
          overflow: hidden;
        }

        iframe {
          &.tilde-tilde-napp-page { display: none; }

          &.napp-page {
            border: none;
            width: 100%;
            height: 100%;
            display: block; /* ensure it's not inline */
          }
        }

        .embedded-load-error {
          height: 100%;
          display: grid;
          place-items: center;
          padding: 24px;
          color: rgb(219, 226, 241);
          background: rgb(18, 21, 30);
          font-size: 14rem;
          line-height: 1.45;
          text-align: center;
        }
      </style>
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
          <iframe
            class='tilde-tilde-napp-page'
            ref=${trustedAppIframeRef$}
            src=${trustedAppIframeSrc$()}
          />
        `}
  `
})
