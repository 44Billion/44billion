// Real components, registry, MessagePorts, app file cache and metadata. Only
// interactive vault/permission/dialog providers are substituted by the runner.
import '#config/polyfills.js'
import { provideAppI18n } from '#i18n/index.js'
import { f, useStore, useGlobalStore, useClosestStore, useWebStorage } from '#f'
import { useInitInstanceMetadata } from '#hooks/use-instance-metadata.js'
import { instanceMetadata } from '#services/instance-metadata/index.js'
import { getAppBridgeState, getAppBridgeSpecs, disposeAppBridge } from '#helpers/window-message/app-bridge-registry.js'
import { retryAppBridge } from '#helpers/window-message/app-bridge.js'
import { addressObjToAppId } from '#helpers/app.js'
import { base16ToBase62 } from 'libp2r2p/base62'
import { encode } from 'libp2r2p/base93'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToBase16 } from 'libp2r2p/base16'
import { saveSiteManifestToDb } from '#services/idb/browser/queries/site-manifest.js'
import { run } from '#services/idb/browser/index.js'
import AppUpdater from '#services/app-updater/index.js'
import '#zones/screen/index.js'
import '#zones/single-napp/index.js'
import '#zones/app-bridge-host.js'

provideAppI18n()
const pubkey = '11'.repeat(32)
const userPk = base16ToBase62(pubkey, { mode: 'integer', minLength: 43 })
const appId = addressObjToAppId({ kind: 35128, pubkey, dTag: 'bridge-test' })
const fixture = window.fixture = { appId, userPk, instanceMetadata, getAppBridgeState, getAppBridgeSpecs, retryAppBridge, disposeAppBridge, AppUpdater, dialogs: [], loaded: [] }

const bytes = new TextEncoder().encode(`<!doctype html><html><head><title>Bridge Test</title></head><body>Cached app loaded<script>
window.documentToken = Math.random().toString(36);
window.napp.getInstanceMetadata().then(metadata => {
  parent.postMessage({code:'FIXTURE_LOADED', metadata, token:documentToken}, '${location.origin}');
});
window.addEventListener('message', async event => {
  if(event.origin !== '${location.origin}' || event.source !== parent) return;
  if(event.data.code === 'FIXTURE_MIN_WIDTH') window.napp.setMinWidth(event.data.width);
  if(event.data.code === 'FIXTURE_NAVIGATE') location.href = event.data.path;
});
</script></body></html>`)
const root = bytesToBase16(sha256(bytes))
await saveSiteManifestToDb({ kind: 35128, pubkey, id: '22'.repeat(32), created_at: 1, content: '', tags: [['d', 'bridge-test'], ['name', 'Bridge Test'], ['path', '/index.html', root]] })
await run('put', [{ appId, fx: root, pos: 0, total: 1, service: 'blossom', evt: { kind: 34601, tags: [['mmr', '0', '1', '']], content: encode(bytes) } }], 'fileChunks')
for (const [key, value] of Object.entries({
  session_workspaceKeys: ['ws'], session_openWorkspaceKeys: ['ws'],
  session_defaultUserPk: userPk,
  session_workspaceByKey_ws_userPk: userPk,
  session_workspaceByKey_ws_pinnedAppIds: [appId],
  [`session_workspaceByKey_ws_appById_${appId}_appKeys`]: ['window', 'peer'],
  session_appByKey_window_id: appId, session_appByKey_peer_id: appId,
  session_appByKey_window_route: '/initial',
  [`session_appById_${appId}_name`]: 'Bridge Test',
  [`session_subdomainByUserAndApp_${userPk}_${appId}`]: '0',
  local_widgets: {}
})) localStorage.setItem(key, JSON.stringify(value))
sessionStorage.setItem('session_appByKey_window_visibility', '"open"')
sessionStorage.setItem('session_appByKey_peer_visibility', '"closed"')
window.addEventListener('message', event => {
  if (event.data?.code === 'FIXTURE_LOADED' && /^http:\/\/\d+\.localhost:/.test(event.origin)) fixture.loaded.push(event.data)
})
f('bridge-test-screen', ({ h }) => {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const state = useStore({ single$: false, windows$: true })
  useGlobalStore('useAppRouter', { openApp () {} })
  useClosestStore('napp', { wsKey: 'ws', appId, initialRoute: '/embedded' })
  useInitInstanceMetadata({ storage })
  Object.assign(fixture, { storage, tabStorage, state })
  return h`<div id='screen' class='multi-window'>
    <div id='workspaces'><div id='windows' style='position:relative;width:800px;height:600px'>
      <widgets-layer />
      ${state.windows$() && h`<app-window props=${{ appKey: 'window', wsKey: 'ws', mruRank: '1-1' }} /><app-window props=${{ appKey: 'peer', wsKey: 'ws', mruRank: '1-2' }} />`}
      ${state.single$() && h`<single-napp-launcher />`}
    </div></div><app-bridge-host />
  </div>`
})
document.body.innerHTML = '<bridge-test-screen></bridge-test-screen>'
