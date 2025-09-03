import { f, useClosestStore, useSignal, useTask, useComputed } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import { appDecode } from '#helpers/nip19.js'
import { addressObjToAppId, appIdToAppSubdomain } from '#helpers/app.js'
import { base62ToBase36 } from '#helpers/base36.js'
import { initMessageListener } from '#helpers/window-message/browser/index.js'

f(function singleNapp () {
  const storage = useWebStorage(localStorage)
  const {
    session_openWorkspaceKeys$: openWorkspaceKeys$
  } = storage
  const wsKey = openWorkspaceKeys$()[0]
  if (!wsKey) throw new Error('User n/a')

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

  return this.h`<single-napp-launcher />`
})

// this won't add napp to web storage, it's supposed to be ephemeral-ish
f(function singleNappLauncher () {
  const { wsKey, appId, initialRoute } = useClosestStore('napp')
  const storage = useWebStorage(localStorage)
  const {
    [`session_workspaceByKey_${wsKey}_userPk$`]: maybeUserPk$,
    session_anonPk$: anonPk$
  } = storage
  const userPkB36$ = useComputed(() => base62ToBase36(maybeUserPk$() || anonPk$(), 50))
  const appSubdomain$ = useComputed(() => appIdToAppSubdomain(appId, userPkB36$()))
  const appIframeRef$ = useSignal()
  const appIframeSrc$ = useSignal('about:blank')

  useTask(
    async ({ cleanup }) => {
      const ac = new AbortController()
      cleanup(() => ac.abort())
      await initMessageListener(userPkB36$(), appId, appSubdomain$(), initialRoute, appIframeRef$(), { signal: ac.signal, isSingleNapp: true })
      appIframeSrc$(`//${appSubdomain$()}.${window.location.host}/~~napp`)
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
      <iframe
        class="tilde-tilde-napp-page"
        ref=${appIframeRef$}
        src=${appIframeSrc$()}
      />
  `
})
