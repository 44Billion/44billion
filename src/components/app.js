import '#config/polyfills.js'
import resetCssString from '#assets/styles/reset.css'
import globalCssString from '#assets/styles/global.css'
import { cssClasses, cssStrings } from '#assets/styles/theme.js'
import { f, useSignal, useTask } from '#f'
import { appEncode } from 'libp2r2p/nip19'
import { decodeAppUrl } from 'libp2r2p/url'
import { appIdToAddressObj } from '#helpers/app.js'
import { isAppUrl, resolveAppUrl } from '#helpers/resolve-app-url.js'
import { initLauncherSw } from '#services/launcher-sw-manager.js'
import { applyPendingStorageRepair } from '#services/storage-audit/bootstrap.js'
import { normalizePersistedListsInStorage } from '#services/storage-audit/audit.js'
import { initTabWorkspaceOrder } from '#helpers/active-workspace-order.js'
import { getRandomId } from '#helpers/misc.js'
import {
  claimAndHydrateStickySession,
  isStickySessionsEnabled,
  readJson,
  SESSION_STICKY_TAB_ID
} from '#services/sticky-sessions/index.js'
import { useInitI18n } from '#i18n/index.js'

// Clear old localStorage data from pre-v2 schema (bundle→siteManifest migration)
// Runs before any component mounts so useWebStorage signals start fresh
if (!localStorage.getItem('storage_version')) {
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('storage_version', '2')
}

// Numeric subdomain redirect: ?subdomain=N -> open the napp in existing tab or this one
const _subdomainParam = new URLSearchParams(location.search).get('subdomain')
if (_subdomainParam) {
  const _raw = localStorage.getItem(`session_subdomainToApp_${_subdomainParam}`)
  if (_raw) {
    try {
      const { appId, userPk } = JSON.parse(_raw)
      const _napp = appEncode({ ...appIdToAddressObj(appId), relays: [] })
      const _appPath = new URLSearchParams(location.search).get('path') || ''
      const _href = `/${_napp}${_appPath}`
      // Ask an existing tab to open the app under the correct user
      const _bc = new BroadcastChannel('44billion_subdomain_nav')
      _bc.postMessage({ href: _href, userPk })
      _bc.close()
      // Close this tab if it was opened by script (e.g. from an app iframe)
      window.close()
      // If still here (manually opened tab), open in this tab under the correct user
      sessionStorage.setItem('_subdomain_nav_userPk', userPk)
      history.replaceState(null, '', _href)
    } catch (_) {
      history.replaceState(null, '', '/')
    }
  } else {
    history.replaceState(null, '', '/')
  }
}

document.documentElement.classList.add(cssClasses.defaultTheme)
document.head.insertAdjacentHTML('beforeend', `<style>${resetCssString}${globalCssString}${cssStrings.defaultTheme}</style>`)

if (IS_DEVELOPMENT) {
  // https://esbuild.github.io/api/#live-reload
  new EventSource('/esbuild').addEventListener('change', () => location.reload())
} else {
  // Offline shell + manual update flow for the launcher (root domain).
  // Only the top-level shell owns the service worker lifecycle: embedded
  // single-napp documents (the launcher inside another app) must not
  // register the same worker or surface the update dialog again.
  // Skipped in development so esbuild live-reload stays unaffected.
  if (window === window.top) initLauncherSw()
}

f('aApp', function () {
  useInitI18n()

  // we rely on us being the top for reusing same
  // key for storage partition
  if (window.location.origin !== window.top.location.origin) {
    window.open(window.location.href, '_blank') // open itself on a new tab to be on top
    return
  }

  const shouldLoadSingleNapp$ = useSignal(null)
  useTask(async () => {
    await applyPendingStorageRepair().catch(error => {
      console.error('[storage-audit] Failed to apply pending repair', error)
    })

    if (window === window.top) {
      initTabWorkspaceOrder({
        localStorageArea: localStorage,
        sessionStorageArea: sessionStorage
      })
      let didHydrate = false
      if (isStickySessionsEnabled()) {
        const requestedSnapshotId = new URLSearchParams(window.location.search).get('sticky')
        const existingTabId = readJson(sessionStorage, SESSION_STICKY_TAB_ID)
        if (!existingTabId || requestedSnapshotId) {
          const workspaceKeys = JSON.parse(localStorage.getItem('session_workspaceKeys') ?? '[]')
          try {
            const result = await claimAndHydrateStickySession({
              localStorageArea: localStorage,
              sessionStorageArea: sessionStorage,
              tabId: getRandomId(),
              requestedSnapshotId,
              resetClonedState: Boolean(requestedSnapshotId),
              workspaceKeys: Array.isArray(workspaceKeys) ? workspaceKeys : []
            })
            didHydrate = result?.hydrated === true
            if (requestedSnapshotId) {
              history.replaceState(history.state, '', `${window.location.pathname}${window.location.hash}`)
            }
          } catch (error) {
            console.warn('[sticky-sessions] Failed to hydrate saved session', error)
          }
        }
      }
      if (didHydrate) {
        normalizePersistedListsInStorage({
          localStorageArea: localStorage,
          sessionStorageArea: sessionStorage
        })
      }
    }

    const firstRoutePart = window.location.pathname.replace(/^\/|\/.*$/g, '')
    if (!isAppUrl(firstRoutePart)) {
      shouldLoadSingleNapp$(false)
      await import('#zones/multi-napp/index.js')
      return
    }

    if (window === window.top || decodeAppUrl(firstRoutePart)?.type === 'entity') {
      shouldLoadSingleNapp$(window !== window.top)
      await (shouldLoadSingleNapp$() ? import('#zones/single-napp/index.js') : import('#zones/multi-napp/index.js'))
      return
    }

    // Embedded named URL: resolve it and normalize to the canonical entity
    // before mounting the single-napp zone.
    const resolvedEntity = await resolveAppUrl(firstRoutePart)
    if (!resolvedEntity) {
      shouldLoadSingleNapp$(false)
      await import('#zones/multi-napp/index.js')
      return
    }
    const restPath = window.location.pathname.slice(firstRoutePart.length + 1)
    const canonicalHref = `/${resolvedEntity}${restPath}${window.location.search}${window.location.hash}`
    history.replaceState(null, '', canonicalHref)
    await import('#zones/single-napp/index.js')
    shouldLoadSingleNapp$(true)
  })
  if (shouldLoadSingleNapp$() === null) return

  return shouldLoadSingleNapp$()
    ? this.h`<single-napp />`
    : this.h`<multi-napp />`
})
