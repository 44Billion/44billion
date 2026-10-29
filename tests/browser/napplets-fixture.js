import '#config/polyfills.js'
import { f, useGlobalStore, useLocation, useWebStorage } from '#f'
import { installStorageEventGuard } from '#helpers/storage-event-guard.js'
import useAppRouter from '#zones/screen/use-app-router.js'
import router from '#zones/multi-napp/router.js'
import '#zones/screen/index.js'
import '#zones/napplet-ui.js'
import { installNapplet } from '#services/napplets/index.js'
import { getInstallation } from '#services/napplets/storage.js'
import { nappletReference } from '#helpers/napplet.js'
import { removeAppFromWorkspace, uninstallAppFromWorkspace } from '#zones/screen/helpers/app-lifecycle.js'
import { cssStrings } from '#assets/styles/theme.js'
import { useInitI18n } from '#i18n/index.js'
import resetCss from '#assets/styles/reset.css'
import globalCss from '#assets/styles/global.css'
import { relayPool } from 'libp2r2p/relay'

// Catalog transport is controlled; manifests still pass production validation.
relayPool.countEvents = async () => ({ success: true, count: 7, approximate: false })
const getEvents = relayPool.getEvents.bind(relayPool)
relayPool.getEvents = (filter, ...args) => {
  if (filter.kinds?.some(kind => [15129, 35129].includes(kind))) {
    const events = window.catalogEvents.filter(event => filter.kinds.includes(event.kind) &&
      (!filter.authors || filter.authors.includes(event.pubkey)) &&
      (!filter['#d'] || event.tags.some(tag => tag[0] === 'd' && filter['#d'].includes(tag[1]))))
    return Promise.resolve({ success: true, result: events.map(event => ({ event })) })
  }
  if (filter.kinds?.includes(10002)) return Promise.resolve({ success: true, result: [] })
  if (filter.kinds?.includes(0)) return Promise.resolve({ success: true, result: window.catalogProfiles.filter(event => !filter.authors || filter.authors.includes(event.pubkey)).map(event => ({ event })) })
  return getEvents(filter, ...args)
}

installStorageEventGuard()
window.fixture = { installNapplet, getInstallation, nappletReference }
f('napplet-test-host', function () {
  const initialStorage = useWebStorage(localStorage)
  if (!initialStorage.session_workspaceKeys$()?.length) {
    initialStorage.session_workspaceKeys$(['ws'])
    initialStorage.session_openWorkspaceKeys$(['ws'])
    initialStorage.session_workspaceByKey_ws_userPk$('alice')
    initialStorage.session_workspaceByKey_ws_pinnedAppIds$([])
    initialStorage.session_workspaceByKey_ws_unpinnedAppIds$([])
  }
  useAppRouter()
  const appRouter = useGlobalStore('useAppRouter')
  const location = useLocation()
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const keys = tabStorage.session_workspaceByKey_ws_openAppKeys$() || []
  Object.assign(window.fixture, {
    storage, tabStorage, appRouter, location,
    close (appKey) {
      tabStorage[`session_appByKey_${appKey}_visibility$`]('closed')
      tabStorage.session_workspaceByKey_ws_openAppKeys$((value = []) => value.filter(key => key !== appKey))
    },
    async uninstall (appKey, appId, userPk) {
      return uninstallAppFromWorkspace({ storage, tabStorage, wsKey: 'ws', appKey, appId, userPk })
    },
    remove: removeAppFromWorkspace
  })
  return this.h`
    <style>${cssStrings.defaultTheme}</style>
    <style>${resetCss + globalCss}</style>
    <style>napplet-test-host { display: block; height: 600px; } napplet-test-host .scope_khjha3 { height: 100dvh; }</style>
    ${keys.map(appKey => this.h({ key: appKey })`<app-window props=${{ appKey, wsKey: 'ws', mruRank: '1-1' }} />`)}
    <napplet-host-ui />
    <system-views style=${location.route$().handler?.mount === 'system-views' ? 'display:flex;position:fixed;inset:0;justify-content:center;' : 'display:none;'} />
  `
})
document.documentElement.classList.add('theme-default')
f('napplet-test-root', function () {
  useInitI18n()
  useLocation(router)
  return this.h`<napplet-test-host />`
})
document.body.insertAdjacentHTML('beforeend', '<napplet-test-root></napplet-test-root>')
