import '#config/polyfills.js'
import resetCssString from '#assets/styles/reset.css'
import globalCssString from '#assets/styles/global.css'
import { f, useSignal, useTask } from '#f'
import { appEncode, NAPP_ENTITY_REGEX } from '#helpers/nip19.js'
import { appIdToAddressObj } from '#helpers/app.js'

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

document.head.insertAdjacentHTML('beforeend', `<style>${resetCssString}${globalCssString}</style>`)

if (IS_DEVELOPMENT) {
  // https://esbuild.github.io/api/#live-reload
  new EventSource('/esbuild').addEventListener('change', () => location.reload())
}

f('aApp', function () {
  // we rely on us being the top for reusing same
  // key for storage partition
  if (window.location.origin !== window.top.location.origin) {
    window.open(window.location.href, '_blank') // open itself on a new tab to be on top
    return
  }

  const shouldLoadSingleNapp$ = useSignal(null)
  useTask(async () => {
    const firstRoutePart = window.location.pathname.replace(/^\/|\/.*$/g, '')
    const isNappRoute = NAPP_ENTITY_REGEX.test(firstRoutePart)

    shouldLoadSingleNapp$(
      window !== window.top &&
      isNappRoute // TODO: or also if @<valid nip05expanded or npub>
    )
    await (shouldLoadSingleNapp$() ? import('#zones/single-napp/index.js') : import('#zones/multi-napp/index.js'))
  })
  if (shouldLoadSingleNapp$() === null) return

  return shouldLoadSingleNapp$()
    ? this.h`<single-napp />`
    : this.h`<multi-napp />`
})
