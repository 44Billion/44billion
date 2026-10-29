import { NAPPLET_STORE_APP_ID } from '#helpers/launcher-app.js'
import { nappletT } from '#i18n/napplets.js'
import { useTask, useCallback, useGlobalStore } from '#f'
import { useLocation } from '#f'
import { useWebStorage } from '#f'
import { appDecode } from 'libp2r2p/nip19'
import { isValidPublicRelayUrl, normalizeRelayUrl, tryDecodeAppUrl } from 'libp2r2p/url'
import { addressObjToAppId } from '#helpers/app.js'
import { isAppUrl, resolveAppUrl } from '#helpers/resolve-app-url.js'
import { useActiveWorkspaceOrder } from '#hooks/use-active-workspace-order.js'
import router from '#zones/multi-napp/router.js'
import { requestNostrDbAppBackfillForWorkspace } from './helpers/nostrdb-app-backfill.js'
import { nappletReferenceFromHref } from '#helpers/napplet.js'
import { installNapplet, resolveNappletReference } from '#services/napplets/index.js'
import { cacheAppMetadata } from '#services/app-file-manager/index.js'

export default function useAppRouter () {
  const loc = useLocation()
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const { order$: openWorkspaceKeys$ } = useActiveWorkspaceOrder(storage, tabStorage)

  const maybeOpenInstalledApp = useCallback((appId, appRoute, wsKey) => {
    wsKey ??= openWorkspaceKeys$()[0]
    if (!wsKey) throw new Error('User n/a')

    const {
      [`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]: appKeys$,
      [`session_workspaceByKey_${wsKey}_pinnedAppIds$`]: pinnedAppIds$,
      [`session_workspaceByKey_${wsKey}_unpinnedAppIds$`]: unpinnedAppIds$
    } = storage
    if (!appKeys$() || (!pinnedAppIds$().includes(appId) && !unpinnedAppIds$().includes(appId))) {
      return { hasOpened: false, isInstalled: false }
    }

    // Only a closed instance can be reused safely: open/minimized windows
    // may contain a route that differs from the URL being opened, and we do
    // not track their current route here.
    function getScore (vis) { return { closed: 0, minimized: 1, open: 2 }[vis] }
    const app = appKeys$()
      .map(key => ({ key, wsKey, vis: tabStorage[`session_appByKey_${key}_visibility$`]() ?? 'closed' }))
      .sort((a, b) => getScore(a.vis) - getScore(b.vis))[0]
    if (!app) throw new Error('App install error')

    switch (app.vis) {
      case 'closed': {
        // open
        tabStorage[`session_appByKey_${app.key}_visibility$`]('open')
        tabStorage[`session_workspaceByKey_${app.wsKey}_openAppKeys$`]((v = [], eqKey) => {
          const i = v.indexOf(app.key)
          if (i !== -1) v.splice(i, 1) // remove
          v.unshift(app.key) // place at beginning
          v[eqKey] = Math.random()
          return v
        })
        // set initial route
        storage[`session_appByKey_${app.key}_route$`](appRoute)
        break
      }
      case 'minimized': {
        // Never reuse a minimized window: it is already mounted with a route
        // that may differ from the requested URL.
        return { hasOpened: false, isInstalled: true }
      }
      case 'open': {
        // tell caller to open new app instance (new appKey)
        return { hasOpened: false, isInstalled: true }
      }
    }

    return { hasOpened: true, isInstalled: true }
  })

  const createAppInstance = useCallback((appId, appRoute, wsKey, { isInstalled = true } = {}) => {
    wsKey ??= openWorkspaceKeys$()[0]
    if (!wsKey) throw new Error('User n/a')

    const app = {
      id: appId,
      key: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      visibility: 'open',
      route: appRoute,
      isNew: false
    }
    storage[`session_workspaceByKey_${wsKey}_appById_${app.id}_appKeys$`](v => {
      // Keep this check explicit. Only a brand-new install may start from an
      // undefined appKeys list; an additional instance must already have one.
      // A generic `if (!Array.isArray(v)) v = []` would hide a regression in
      // workspace initialization.
      if (!isInstalled) v = []
      v.push(app.key)
      return v
    })
    storage[`session_appByKey_${app.key}_id$`](app.id)
    storage[`session_appByKey_${app.key}_route$`](appRoute) // initial route
    tabStorage[`session_appByKey_${app.key}_visibility$`](app.visibility)
    tabStorage[`session_workspaceByKey_${wsKey}_openAppKeys$`]((v = [], eqKey) => {
      const i = v.indexOf(app.key)
      if (i !== -1) v.splice(i, 1) // remove
      v.unshift(app.key) // place at beginning
      v[eqKey] = Math.random()
      return v
    })
    return app
  })

  const openApp = useCallback((napp, appRoute, wsKey) => {
    if (!openWorkspaceKeys$().length) throw new Error()
    wsKey ??= openWorkspaceKeys$()[0]
    const decodedApp = appDecode(napp)
    const appId = addressObjToAppId(decodedApp)
    const decodedAppRelays = decodedApp.relays.slice(0, 4)
      .map(value => {
        try { return normalizeRelayUrl(value) } catch { return undefined }
      })
      .filter(isValidPublicRelayUrl)
      .slice(0, 2)
    if (decodedAppRelays.length > 0) {
      storage[`session_appById_${appId}_relayHints$`](decodedAppRelays)
    }
    const { hasOpened, isInstalled } = maybeOpenInstalledApp(appId, appRoute, wsKey)

    if (hasOpened) return

    const app = createAppInstance(appId, appRoute, wsKey, { isInstalled })

    if (isInstalled) return

    storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`](v => {
      v.unshift(app.id)
      return v
    })
    requestNostrDbAppBackfillForWorkspace({ storage, wsKey, appId: app.id })
  })

  const openNappletStore = useCallback((wsKey = openWorkspaceKeys$()[0]) => {
    if (!wsKey) throw new Error('User n/a')
    const appId = NAPPLET_STORE_APP_ID
    cacheAppMetadata(appId, { name: nappletT('Napplets'), description: '' })
    const { hasOpened, isInstalled } = maybeOpenInstalledApp(appId, '', wsKey)
    if (hasOpened) return
    createAppInstance(appId, '', wsKey, { isInstalled })
    if (!isInstalled) storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`]((v = []) => [appId, ...v])
  })

  useTask(({ track }) => {
    const route = track(() => loc.route$())
    if (!/^\/napplets\/?$/.test(route.url.pathname)) return
    openNappletStore()
    loc.replaceState(history.state, '', '/')
  })

  const openNapplet = useCallback(async (reference, wsKey, { signal } = {}) => {
    wsKey ??= openWorkspaceKeys$()[0]
    if (!wsKey) throw new Error('User n/a')
    const { event, manifest } = await resolveNappletReference(reference, { signal })
    const appId = await installNapplet(event, { signal })
    signal?.throwIfAborted()
    cacheAppMetadata(appId, { name: manifest.title || manifest.dTag || 'Napplet', description: manifest.description })
    const { hasOpened, isInstalled } = maybeOpenInstalledApp(appId, '', wsKey)
    if (hasOpened) return
    createAppInstance(appId, '', wsKey, { isInstalled })
    if (!isInstalled) storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`]((v = []) => [appId, ...v])
  })

  const nappletError$ = useGlobalStore('nappletNavigation', () => ({ error$: '' }))
  useTask(async ({ track, cleanup }) => {
    const href = track(() => loc.route$().url.href)
    let reference
    try { reference = nappletReferenceFromHref(href) } catch (error) {
      nappletError$.error$(error.message)
      loc.replaceState(history.state, '', '/napplets')
      return
    }
    if (!reference) return
    const ac = new AbortController()
    cleanup(() => ac.abort())
    try {
      await openNapplet(reference, undefined, { signal: ac.signal })
      if (!ac.signal.aborted) loc.replaceState(history.state, '', '/')
    } catch (error) {
      if (!ac.signal.aborted) {
        nappletError$.error$(error.message)
        loc.replaceState(history.state, '', '/napplets')
      }
    }
  })

  useTask(async ({ track }) => {
    const route = track(() => loc.route$())
    const firstPart = route.url.pathname.split('/')[1]
    if (!isAppUrl(firstPart)) return

    let napp
    const decodedFirstPart = tryDecodeAppUrl(firstPart)
    if (decodedFirstPart?.type === 'entity') {
      napp = decodedFirstPart.entity
    } else {
      napp = await resolveAppUrl(firstPart)
      if (!napp) {
        loc.replaceState(history.state, '', '/')
        return
      }
      // The user may have navigated away while the NIP-05/manifest lookup ran.
      if (loc.route$().url.pathname.split('/')[1] !== firstPart) return
    }

    let appRoute
    let { appPath } = route.params
    appPath = appPath.replace(/^\/{0,}/, '/')
    const { search, hash } = route.url
    if (appPath !== '/' || search || hash) {
      appRoute = appPath + search + hash
    } else appRoute = ''

    if (IS_DEVELOPMENT) {
      console.info('[app-router] opening app URL', {
        firstPart,
        appRoute,
        search,
        hash,
        href: window.location.href
      })
    }

    // Check if a subdomain redirect stashed a target user
    let targetWsKey
    const navUserPk = sessionStorage.getItem('_subdomain_nav_userPk')
    if (navUserPk) {
      sessionStorage.removeItem('_subdomain_nav_userPk')
      targetWsKey = storage.session_workspaceKeys$().find(
        k => storage[`session_workspaceByKey_${k}_userPk$`]() === navUserPk
      )
    }

    try { openApp(napp, appRoute, targetWsKey) } catch (err) { console.log(err) } finally {
      loc.replaceState(history.state, '', '/') // TODO: replace with previous url if available
    }
  })

  useGlobalStore('useAppRouter', () => ({
    async openApp (href, wsKey) {
      const url = new URL(href, window.location.origin)
      if (/^\/napplets\/?$/.test(url.pathname)) return openNappletStore(wsKey)
      const napplet = nappletReferenceFromHref(url.href)
      if (napplet) return openNapplet(napplet, wsKey)
      const firstPart = url.pathname.split('/')[1]
      let napp
      const decodedFirstPart = tryDecodeAppUrl(firstPart)
      if (decodedFirstPart?.type === 'entity') {
        napp = decodedFirstPart.entity
      } else {
        napp = await resolveAppUrl(firstPart)
        if (!napp) throw new Error('Could not resolve app URL')
      }

      let appRoute
      let { appPath } = router.find(url.pathname.replace(/\/+$/, '')).params
      appPath = appPath.replace(/^\/{0,}/, '/')
      const { search, hash } = url
      if (appPath !== '/' || search || hash) {
        appRoute = appPath + search + hash
      } else appRoute = ''

      openApp(napp, appRoute, wsKey)
    },
    openNappletStore,
    openIntentTarget (appId, wsKey, { reuse = true, focus = true } = {}) {
      if (!openWorkspaceKeys$().includes(wsKey)) throw new Error('Workspace is closed')
      const installed = [...(storage[`session_workspaceByKey_${wsKey}_pinnedAppIds$`]() || []), ...(storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`]() || [])]
      if (!installed.includes(appId)) throw new Error('Intent handler is not installed')
      const keys = storage[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]() || []
      const key = reuse && keys.find(key => (tabStorage[`session_appByKey_${key}_visibility$`]() || 'closed') !== 'closed')
      if (!key) return createAppInstance(appId, '', wsKey).key
      tabStorage[`session_appByKey_${key}_visibility$`]('open')
      if (focus) tabStorage[`session_workspaceByKey_${wsKey}_openAppKeys$`]((value = []) => [key, ...value.filter(item => item !== key)])
      return key
    },
    openNewAppInstance (appId, wsKey) {
      return createAppInstance(appId, '', wsKey, { isInstalled: true }).key
    }
  }))
}
