import { f, useClosestStore, useSignal, useTask, useComputed } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import { appDecode } from '#helpers/nip19.js'
import { addressObjToAppId, appIdToAppSubdomain } from '#helpers/app.js'
import { base62ToBase36 } from '#helpers/base36.js'
import { initMessageListener } from '#helpers/window-message/browser/index.js'
import { useVaultModalStore, useRequestVaultMessage } from '#zones/vault-modal/index.js'
import '#shared/napp-assets-caching-progress-bar.js'

f(function singleNapp () {
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
    <single-napp-launcher />
  `
})

// this won't add napp to web storage, it's supposed to be ephemeral-ish
f(function singleNappLauncher () {
  const { wsKey, appId, initialRoute } = useClosestStore('napp')
  const storage = useWebStorage(localStorage)
  const {
    [`session_workspaceByKey_${wsKey}_userPk$`]: userPk$
  } = storage
  const userPkB36$ = useComputed(() => base62ToBase36(userPk$(), 50))
  const appSubdomain$ = useComputed(() => appIdToAppSubdomain(appId, userPkB36$()))
  const trustedAppIframeRef$ = useSignal()
  const trustedAppIframeSrc$ = useSignal('about:blank')
  const appIframeRef$ = useSignal()
  const appIframeSrc$ = useSignal('about:blank')
  const { cachingProgress$ } = useClosestStore('<napp-assets-caching-progress-bar>', {
    cachingProgress$: {
      // [filename]: {
      //   progress: 0, // 0-100
      //   // Note: don't use it when it's 0
      //   totalByteSizeEstimate: 0 // 51000 * (total number of chunks - 1); don't count last chunk as it may be smaller)
      // }
    }
  })
  const { requestVaultMessage } = useRequestVaultMessage()

  useTask(
    async ({ cleanup }) => {
      const ac = new AbortController()
      cleanup(() => ac.abort())
      await initMessageListener(
        userPkB36$(), appId, appSubdomain$(), initialRoute,
        trustedAppIframeRef$(), appIframeRef$(), appIframeSrc$,
        cachingProgress$, requestVaultMessage,
        { signal: ac.signal, isSingleNapp: true }
      )
      trustedAppIframeSrc$(`//${appSubdomain$()}.${window.location.host}/~~napp`)
    },
    { after: 'rendering' }
  )

  return this.h`
      <style>
        iframe {
          &.tilde-tilde-napp-page { display: none; }

          &.napp-page {
            border: none;
            width: 100%;
            height: 100%;
            display: block; /* ensure it's not inline */
          }
        }
      </style>
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
  `
})
