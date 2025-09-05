import { useTask, useCallback } from '#f'
import useLocation from '#hooks/use-location.js'
import useWebStorage from '#hooks/use-web-storage.js'
import { NAPP_ENTITY_REGEX, appDecode } from '#helpers/nip19.js'
import { addressObjToAppId } from '#helpers/app.js'

export default function useAppRouter () {
  const loc = useLocation()
  const storage = useWebStorage(localStorage)
  const {
    session_openWorkspaceKeys$: openWorkspaceKeys$
  } = storage

  const maybeOpenInstalledApp = useCallback((appId, appRoute) => {
    const wsKey = openWorkspaceKeys$()[0]
    if (!wsKey) throw new Error('User n/a')

    const {
      [`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]: appKeys$,
      [`session_workspaceByKey_${wsKey}_pinnedAppIds$`]: pinnedAppIds$,
      [`session_workspaceByKey_${wsKey}_pinnedAppIds$`]: unpinnedAppIds$
    } = storage
    if (!pinnedAppIds$().includes(appId) && !unpinnedAppIds$().includes(appId)) {
      return { hasOpened: false, isInstalled: false }
    }

    function getScore (vis) { return { closed: 3, minimized: 2, open: 1 }[vis] }
    const app = appKeys$()
      .map(key => ({ key, wsKey, vis: storage[`session_appByKey_${key}_visibility$`]() }))
      .sort((a, b) => getScore(b.vis) - getScore(a.vis))[0]
    if (!app) throw new Error('App install error')

    switch (app.vis) {
      case 'closed': {
        // open
        storage[`session_appByKey_${app.key}_visibility$`]('open')
        storage[`session_workspaceByKey_${app.wsKey}_openAppKeys$`]((v, eqKey) => {
          v.domOrder.unshift(app.key) // it is ok to change domOrder before placing iframes on DOM
          v.cssOrder.unshift(app.key)
          v[eqKey] = Math.random()
          return v
        })
        // set initial route
        storage[`session_appByKey_${app.key}_route$`](appRoute)
        break
      }
      case 'minimized': {
        // maximize
        const appKey = app.key
        storage[`session_appByKey_${appKey}_visibility$`]('open')
        storage[`session_workspaceByKey_${app.wsKey}_openAppKeys$`]((v, eqKey) => {
          const i = v.cssOrder.indexOf(appKey)
          if (i !== -1) v.cssOrder.splice(i, 1) // remove
          v.cssOrder.unshift(appKey) // place at beginning
          v[eqKey] = Math.random()
          return v
        })
        // set initial route
        storage[`session_appByKey_${app.key}_route$`](appRoute)
        break
      }
      case 'open': {
        // tell caller to open new app instance (new appKey)
        return { hasOpened: false, isInstalled: true }
      }
    }

    return { hasOpened: true, isInstalled: true }
  })

  const openApp = useCallback((napp, appRoute) => {
    if (!openWorkspaceKeys$().length) throw new Error()
    const decodedApp = appDecode(napp)
    const appId = addressObjToAppId(decodedApp)
    if (decodedApp.relays.length > 0) {
      storage[`session_appById_${appId}_relayHints$`](decodedApp.relays)
    }
    const { hasOpened, isInstalled } = maybeOpenInstalledApp(appId, appRoute)

    if (hasOpened) return

    const app = {
      id: appId,
      key: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      visibility: 'open',
      route: appRoute,
      isNew: false
    }
    const wsKey = openWorkspaceKeys$()[0]
    storage[`session_workspaceByKey_${wsKey}_appById_${app.id}_appKeys$`](v => {
      v.push(app.key)
      return v
    })
    storage[`session_appByKey_${app.key}_id$`](app.id)
    storage[`session_appByKey_${app.key}_route$`](appRoute) // initial route
    storage[`session_appByKey_${app.key}_visibility$`](app.visibility)
    storage[`session_workspaceByKey_${wsKey}_openAppKeys$`]((v, eqKey) => {
      v.domOrder.unshift(app.key) // it is ok to change domOrder before placing iframes on DOM
      v.cssOrder.unshift(app.key)
      v[eqKey] = Math.random()
      return v
    })

    if (isInstalled) return

    storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`](v => {
      v.unshift(app.id)
      return v
    })
  })

  useTask(({ track }) => {
    if (!NAPP_ENTITY_REGEX.test(track(() => loc.url$().pathname.split('/')[1]))) return

    let appRoute
    let { napp, appPath } = loc.params$()
    appPath = appPath.replace(/^\/{0,}/, '/')
    const { search, hash } = loc.url$()
    if (appPath !== '/' || search || hash) {
      appRoute = appPath + search + hash
    } else appRoute = ''

    try { openApp(napp, appRoute) } catch (err) { console.log(err) } finally {
      loc.replaceState(history.state, '', '/') // TODO: replace with previous url if available
    }
  })
}
