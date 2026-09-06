import { setAccountsState } from '#zones/screen/use-init-or-reset-screen.js'
import { allocateAppSubdomain, retireSubdomainsFor, subdomainStorage } from '#helpers/subdomain-mapping.js'
import { processSubdomainCleanup } from '#services/subdomain-cleanup.js'
import { askAppToClearData } from '#zones/screen/helpers/draft-app-runtime-reset.js'
import { setAppPersonaSelection, updatePersonaUserPks } from '#services/personas/index.js'
import { useInitPersonas } from '#hooks/use-personas.js'
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
const fixture = window.fixture = { setAccountsState, allocateAppSubdomain, retireSubdomainsFor, subdomainStorage, processSubdomainCleanup, askAppToClearData, appId, userPk, instanceMetadata, getAppBridgeState, getAppBridgeSpecs, retryAppBridge, disposeAppBridge, AppUpdater, toBase62: hex => base16ToBase62(hex, { mode: 'integer', minLength: 43 }), setAppPersonaSelection, updatePersonaUserPks, dialogs: [], loaded: [] }

const bytes = new TextEncoder().encode(`<!doctype html><html><head><title>Bridge Test</title></head><body>Cached app loaded<script>
window.documentToken = Math.random().toString(36);
window.personaChanges = [];
window.scopedSigners = new Map();
window.napp.onPersonaPublicKeysChanged(keys => window.personaChanges.push(keys));
window.napp.getInstanceMetadata().then(metadata => {
  parent.postMessage({code:'FIXTURE_LOADED', metadata, token:documentToken}, '${location.origin}');
});
window.addEventListener('message', async event => {
  if(event.origin !== '${location.origin}' || event.source !== parent) return;
  if(event.data.code === 'FIXTURE_PERSONA_QUERY') {
    const signers = [];
    for (const pk of event.data.pubkeys) {
      if (!scopedSigners.has(pk)) scopedSigners.set(pk, window.napp.getWindowNostrFor(pk));
      try { signers.push(await scopedSigners.get(pk).getPublicKey()); }
      catch (error) { signers.push({error:error.code}); }
    }
    parent.postMessage({code:'FIXTURE_PERSONA_REPLY', requestId:event.data.requestId, payload:{
      keys:await window.napp.getPersonaPublicKeys(), changes:personaChanges,
      metadata:await window.napp.getInstanceMetadata(), peek:await window.nostr.peekPublicKey(), href:location.pathname+location.search+location.hash, token:documentToken, signers
    }}, event.origin);
  }
  if(event.data.code === 'FIXTURE_STORAGE') {
    const db = await new Promise((resolve,reject)=>{
      const request=indexedDB.open('identity-test',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('data');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    if(event.data.value) {
      localStorage.setItem('identity-test',event.data.value);
      sessionStorage.setItem('identity-test',event.data.value);
      await new Promise((resolve,reject)=>{const tx=db.transaction('data','readwrite');tx.objectStore('data').put(event.data.value,'value');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
    }
    const value=await new Promise((resolve,reject)=>{const request=db.transaction('data').objectStore('data').get('value');request.onsuccess=()=>resolve(request.result??null);request.onerror=()=>reject(request.error)});
    db.close();
    parent.postMessage({code:'FIXTURE_STORAGE_REPLY', requestId:event.data.requestId, payload:{local:localStorage.getItem('identity-test'),session:sessionStorage.getItem('identity-test'),db:value}},event.origin);
  }
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
  const state = useStore({ single$: false, windows$: true, menuAnchor$: null })
  const menu = useClosestStore('<a-menu>', () => ({
    isOpen$: false, page$: 'actions',
    app$ () { return { id: appId, key: 'window', workspaceKey: 'ws', visibility: tabStorage.session_appByKey_window_visibility$(), ref: state.menuAnchor$() } },
    close () { this.isOpen$(false); this.page$('actions') }
  }))
  useGlobalStore('useAppRouter', { openApp () {} })
  useClosestStore('napp', { wsKey: 'ws', appId, initialRoute: '/embedded' })
  useInitPersonas({ storage })
  useInitInstanceMetadata({ storage })
  Object.assign(fixture, { storage, tabStorage, state, menu })
  return h`<button id='fixture-menu-anchor' style='position:fixed;left:450px;top:400px;anchor-name:--app-launchers-menu' ref=${state.menuAnchor$} onclick=${() => menu.isOpen$(true)}>App menu</button><app-launchers-menu /><div id='screen' class='multi-window'>
    <div id='workspaces'><div id='windows' style='position:relative;width:800px;height:600px'>
      <widgets-layer />
      ${state.windows$() && h`<app-window props=${{ appKey: 'window', wsKey: 'ws', mruRank: '1-1' }} /><app-window props=${{ appKey: 'peer', wsKey: 'ws', mruRank: '1-2' }} />`}
      ${state.single$() && h`<single-napp-launcher />`}
    </div></div><app-bridge-host />
  </div>`
})
document.body.innerHTML = '<bridge-test-screen></bridge-test-screen>'
