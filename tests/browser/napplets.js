import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { build, stop } from 'esbuild'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { launchChrome } from './runtime/chrome.js'
import { nappletDescriptor, nappletReference } from '../../src/helpers/napplet.js'

// Real app router, window, IndexedDB installation, sandbox and Kehto dispatcher.
// Signing permissions/vault forwarding have separate adapter tests.
const stubs = {
  '#zones/vault-modal/index.js': 'export const useVaultActor=()=>({askVault(){throw new Error("Unexpected vault call")}});export const useVaultModalStore=()=>({});export const tellVault=()=>{};export const flushQueuedVaultAcceptedMessages=async()=>{}',
  '#zones/permission-dialog/index.js': 'export const permissionDialogLocales={};export const usePermissionDialogStore=()=>({requestPermission(){throw new Error("Unexpected permission request")},clearApp(){}})',
  '#zones/confirmation-dialog/index.js': 'export const useConfirmationDialogStore=()=>({requestConfirmation(){throw new Error("Unexpected confirmation")}})'
}
let browser
const server = createServer()
const diagnostics = new URL('../../tmp/napplets-browser', import.meta.url).pathname
const catalogKeys = Array.from({ length: 8 }, () => generateSecretKey())
const iconBytes = await readFile(new URL('../../src/assets/media/icon-192.png', import.meta.url))
const iconHash = bytesToHex(sha256(iconBytes))
const catalogHtml = new TextEncoder().encode('<p>Catalog fixture</p>')
const catalogHash = bytesToHex(sha256(catalogHtml))
const catalogEvents = catalogKeys.map((key, index) => finalizeEvent({
  kind: 35129, created_at: 1,
  content: 'A focused sandboxed applet. Browse content, keep your work, and reopen it in your workspace. '.repeat(index === 0 ? 10 : 1),
  tags: [['d', `catalog-${index}`], ['title', `Example Napplet ${index + 1}`], ['x', catalogHash], ['server', 'https://icons.example.com'], ...(index === 0 ? [['icon', iconHash, 'image/png']] : []), ...(index % 2 ? [['R', 'dm']] : [])]
}, key))
const catalogProfiles = catalogKeys.map((key, index) => finalizeEvent({ kind: 0, created_at: 1, tags: [], content: JSON.stringify({ display_name: `Publisher ${index + 1}` }) }, key))
try {
  const bundle = await build({
    entryPoints: { fixture: 'tests/browser/napplets-fixture.js' }, bundle: true, write: false, format: 'esm',
    splitting: true, outdir: '/tmp/44b-napplet-browser-build',
    define: { IS_DEVELOPMENT: 'false', IS_PRODUCTION: 'true', LAUNCHER_DEPLOY_HASH: '"napplet-test"' },
    loader: { '.css': 'text', '.html': 'text', '.webp': 'dataurl', '.svg': 'text' },
    plugins: [{
      name: 'host-dialogs', setup (builder) {
        builder.onResolve({ filter: /.*/ }, args => stubs[args.path] ? { path: args.path, namespace: 'fixture' } : undefined)
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], resolveDir: process.cwd() }))
      }
    }]
  })
  stop()
  server.on('request', (request, response) => {
    const file = bundle.outputFiles.find(file => file.path === `/tmp/44b-napplet-browser-build${request.url}`)
    if (file) { response.setHeader('Content-Type', 'text/javascript'); response.end(file.contents); return }
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><html><body><script>window.catalogEvents=${JSON.stringify(catalogEvents)};window.catalogProfiles=${JSON.stringify(catalogProfiles)}</script><script type="module" src="/fixture.js"></script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://localhost:${server.address().port}`
  browser = await launchChrome({
    intercept: request => {
      const bytes = request.url === `https://icons.example.com/${iconHash}` ? iconBytes : request.url === `https://icons.example.com/${catalogHash}` ? catalogHtml : null
      return bytes ? { responseCode: 200, responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Content-Type', value: request.url.endsWith(iconHash) ? 'image/png' : 'text/html' }], body: Buffer.from(bytes).toString('base64') } : null
    }
  })
  const evaluate = expression => browser.evaluate(expression, origin)
  const act = expression => evaluate(`(async () => { ${expression} })()`)
  const catalogVisible = () => evaluate('!!document.querySelector("app-window napplet-catalog") && document.querySelector("napplet-catalog").getBoundingClientRect().height > 0')
  await browser.navigate(`${origin}/napplets`)
  await browser.until(() => evaluate('!!window.fixture?.appRouter'), 'napplet host')
  await browser.until(catalogVisible, 'catalog visible at direct /napplets URL')
  assert.equal(await evaluate('document.querySelector("napplet-catalog .heading")'), null)
  assert.equal(await evaluate('location.pathname'), '/')
  assert.equal(await evaluate('document.querySelectorAll("napplet-catalog input").length'), 2)
  await evaluate('window.uploadSelection = null; fixture.confirmNappletUpload({ name: \'Upload fixture\', filename: \'photo.png\', size: 1024, pubkey: \'account\', servers: [\'https://preferred.example\'], signal: new AbortController().signal }).then(value => { window.uploadSelection = value }); true')
  await browser.until(() => evaluate('!!document.querySelector("napplet-upload-dialog dialog")?.open'), 'upload consent dialog')
  assert.equal(await evaluate('document.querySelector("napplet-upload-dialog input[type=checkbox]").checked'), true)
  await evaluate('document.querySelector("napplet-upload-dialog input[type=checkbox]").click()')
  await evaluate('document.querySelector("napplet-upload-dialog .actions button:last-child").click()')
  await browser.until(() => evaluate('!!document.querySelector("napplet-upload-dialog [role=alert]")'), 'upload requires a destination')
  await evaluate('const input = document.querySelector(\'napplet-upload-dialog input[type=url]\'); input.value = \'https://additional.example\'; input.dispatchEvent(new Event(\'input\', { bubbles: true }))')
  await evaluate('document.querySelector("napplet-upload-dialog .actions button:last-child").click()')
  await browser.until(() => evaluate('Array.isArray(window.uploadSelection)'), 'upload destination selection')
  assert.deepEqual(await evaluate('window.uploadSelection'), ['https://additional.example'])

  await browser.until(() => evaluate('document.querySelectorAll("napplet-catalog article").length === 8'), 'verified catalog cards')
  await browser.until(() => evaluate('!!document.querySelector("napplet-catalog .app-icon img")?.naturalWidth'), 'verified napplet icon')
  await browser.until(() => evaluate('[...document.querySelectorAll("napplet-catalog .author")].every(el=>el.textContent.startsWith("Publisher "))'), 'publisher names')
  assert.equal(await evaluate('[...document.querySelectorAll("napplet-catalog article button")].every(el=>el.textContent === "Install" && !el.disabled)'), true)
  await mkdir(diagnostics, { recursive: true })
  for (const width of [1280, 360]) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
    for (const theme of ['light', 'dark']) {
      await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, browser.sessionId)
      const layout = await evaluate(`(() => {
        const page = document.querySelector('napplet-catalog');
        const rect = page.getBoundingClientRect();
        const heading = rect;
        const scroll = page.querySelector('.scroll-area').getBoundingClientRect();
        const content = page.querySelector('.content');
        return {
          display: getComputedStyle(page).display,
          width: rect.width, height: rect.height,
          stacked: scroll.top >= heading.top - 1,
          overflow: content.scrollWidth > content.clientWidth,
          controlHeights: [...page.querySelectorAll('input, button')].map(el => el.getBoundingClientRect().height),
          descriptionsClamped: [...page.querySelectorAll('.description')].every(el=>getComputedStyle(el).webkitLineClamp === '5' && el.getBoundingClientRect().height <= 5 * parseFloat(getComputedStyle(el).lineHeight) + 1),
          longDescriptionClipped: [...page.querySelectorAll('.description')].some(el=>el.scrollHeight > el.clientHeight)
        };
      })()`)
      assert.equal(layout.display, 'flex')
      assert.ok(layout.width <= width && layout.width >= width - 20)
      assert.ok(layout.height > 0 && layout.height <= 800)
      assert.equal(layout.stacked, true)
      assert.equal(layout.overflow, false)
      assert.ok(layout.controlHeights.every(height => height >= 36))
      assert.equal(layout.descriptionsClamped, true)
      assert.equal(layout.longDescriptionClipped, true)
      const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, browser.sessionId)
      await writeFile(`${diagnostics}/catalog-${width}-${theme}.png`, Buffer.from(data, 'base64'))
    }
  }
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
  await browser.navigate(`${origin}/napplets`)
  await browser.until(catalogVisible, 'catalog visible after reload')
  await evaluate('window.storeKey=fixture.tabStorage.session_workspaceByKey_ws_openAppKeys$()[0];window.storeKeys=[...fixture.storage["session_workspaceByKey_ws_appById_builtin-napplet-store_appKeys$"]()]')
  assert.equal(await evaluate('fixture.storage["session_appByKey_"+storeKey+"_id$"]()'), 'builtin-napplet-store')
  assert.equal(await evaluate('document.querySelector("napplet-catalog iframe")'), null)
  assert.equal(await evaluate('Object.keys(localStorage).some(key=>key.includes("subdomainByUserAndApp_") && key.includes("builtin-napplet-store"))'), false)
  await evaluate('for (const key of fixture.tabStorage.session_workspaceByKey_ws_openAppKeys$()) fixture.close(key)')
  await act('await fixture.appRouter.openApp("/napplets")')
  assert.equal(await evaluate('storeKeys.includes(fixture.tabStorage.session_workspaceByKey_ws_openAppKeys$()[0])'), true)
  await browser.until(catalogVisible, 'closed store reopened in its window')
  await evaluate('document.querySelector("napplet-catalog article button").click()')
  await browser.until(() => evaluate('!!document.querySelector("napplet-frame iframe")'), 'installation from store window')
  await evaluate('for (const key of fixture.tabStorage.session_workspaceByKey_ws_openAppKeys$()) fixture.close(key)')
  await evaluate('for(const [key,value] of Object.entries({session_workspaceKeys:[\'ws\'],session_openWorkspaceKeys:[\'ws\'],session_workspaceByKey_ws_userPk:\'alice\',session_workspaceByKey_ws_pinnedAppIds:[],session_workspaceByKey_ws_unpinnedAppIds:[]}))fixture.storage[key+\'$\'](value)')
  const html = `<!doctype html><html><body><script>
    let seq=0;
    const pending=new Map();
    addEventListener('message',event=>{if(event.source!==parent)return;if(event.data.type==='keys.action')parent.postMessage({fixtureAction:event.data.actionId},'*');const resolve=pending.get(event.data.id);if(resolve){pending.delete(event.data.id);resolve(event.data)}});
    const call=(type,data={})=>new Promise(resolve=>{const id='request-'+(++seq);pending.set(id,resolve);parent.postMessage({type,id,...data},'*')});
    (async()=>{
      const previous=await window.napplet.storage.getItem('counter');
      await window.napplet.storage.setItem('counter',String(Number(previous||0)+1));
      const theme=await call('theme.get');
      const identity=await call('identity.getPublicKey');
      const schema=await call('config.registerSchema',{schema:{type:'object',properties:{label:{type:'string',title:'Label',default:'Default label'}}},version:1});
      const config=await call('config.get');
      const count=await call('count.query',{filters:[{kinds:[1]}]});
      const resource=await call('resource.bytes',{url:'https://icons.example.com/${iconHash}'});
      const resourceInfo=await call('resource.info');
      const uploadInfo=await window.napplet.upload.info();
      const keys=await call('keys.registerAction',{action:{id:'fixture-action',label:'Fixture action',defaultKey:'Alt+K'}});
      const media=await call('media.session.create',{owner:'napplet',sessionId:'fixture-player',metadata:{title:'Fixture media'},capabilities:['play','pause']});
      const notice=await call('notify.send',{title:'Runtime notification',body:'Notification delivered'});
      addEventListener('message',event=>{if(event.source!==parent)return;if(event.data.fixtureOpenSettings)window.napplet.config.openSettings();if(event.data.fixtureKeys)parent.postMessage({type:'keys.forward',key:'k',code:'KeyK',alt:true},'*')});
      let blocked=false;try{localStorage.getItem('secret')}catch{blocked=true}
      parent.postMessage({fixtureReport:true,previous,blocked,domains:Object.keys(window.napplet),theme:theme.theme,identity,schema,config,count,resource,resourceInfo,uploadInfo,keys,media,notice},'*');
    })().catch(error=>parent.postMessage({fixtureError:String(error)},'*'));
  </script></body></html>`
  const bytes = new TextEncoder().encode(html)
  const event = finalizeEvent({ kind: 35129, created_at: 1, content: 'Browser persistence fixture', tags: [['d', 'counter'], ['title', 'Counter'], ['x', bytesToHex(sha256(bytes))], ['R', 'storage'], ['R', 'dm'], ['O', 'theme']] }, generateSecretKey())
  await act(`window.reports=[];window.reportErrors=[];addEventListener('message',event=>{if(event.data?.fixtureReport)reports.push(event.data);if(event.data?.fixtureError)reportErrors.push(event.data.fixtureError)});window.event=${JSON.stringify(event)};window.bytes=new Uint8Array(${JSON.stringify([...bytes])});window.appId=await fixture.installNapplet(event,{fetchBlob:async()=>bytes});window.reference=fixture.nappletReference(event);await fixture.appRouter.openApp('/napplet/'+reference)`)
  await browser.until(() => evaluate('reports.length || reportErrors.length'), 'first napplet result')
  assert.deepEqual(await evaluate('reportErrors'), [])
  assert.equal(await evaluate('reports[0].previous'), null)
  assert.equal(await evaluate('reports[0].blocked'), true)
  assert.equal(await evaluate('!!reports[0].theme?.colors?.background'), true)
  assert.equal(await evaluate('document.querySelector("napplet-frame iframe").getAttribute("sandbox")'), 'allow-scripts')
  assert.equal(await evaluate('reports[0].domains.includes("outbox")'), true)
  assert.equal(await evaluate('reports[0].domains.includes("dm")'), false)
  assert.equal(await evaluate('reports[0].domains.includes("upload")'), true)
  assert.equal(await evaluate('reports[0].uploadInfo.rails[0].rail'), 'blossom')
  assert.equal(await evaluate('reports[0].uploadInfo.maxBytes'), 64 * 1024 * 1024)
  assert.equal(await evaluate('reports[0].schema.ok'), true)
  assert.equal(await evaluate('reports[0].count.count'), 7)
  assert.equal(await evaluate('!!reports[0].resource.error'), false)
  assert.equal(await evaluate('!!reports[0].resourceInfo.error'), false)
  assert.equal(await evaluate('reports[0].keys.binding'), 'Alt+K')
  assert.equal(await evaluate('reports[0].media.owner'), 'napplet')
  await browser.until(() => evaluate('document.querySelector("napplet-host-ui .players").textContent.includes("Fixture media")'), 'host media controls')
  await evaluate('window.actions=[];addEventListener("message",event=>{if(event.data?.fixtureAction)actions.push(event.data.fixtureAction)});const frame=document.querySelector("napplet-frame iframe");frame.focus();frame.contentWindow.postMessage({fixtureKeys:true},"*")')
  await browser.until(() => evaluate('actions.includes("fixture-action")'), 'focused napplet keyboard action')
  await browser.until(() => evaluate('[...document.querySelectorAll("napplet-host-ui .notice")].some(el=>el.textContent.includes("Runtime notification"))'), 'shell notification presentation')
  await evaluate('document.querySelector("napplet-frame iframe").contentWindow.postMessage({fixtureOpenSettings:true},"*")')
  await browser.until(() => evaluate('document.querySelector("napplet-host-ui dialog").open && !!document.querySelector("napplet-host-ui dialog input")'), 'shell configuration form')
  await evaluate('const input=document.querySelector("napplet-host-ui dialog input");input.value="Saved configuration";input.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("napplet-host-ui dialog .primary").click()')
  await browser.until(() => evaluate('!document.querySelector("napplet-host-ui dialog").open'), 'configuration saved')
  assert.equal(await evaluate('Object.keys(localStorage).filter(key=>key.startsWith("local_nappletState_")).some(key=>JSON.parse(localStorage.getItem(key))["launcher:config"]===JSON.stringify({label:"Saved configuration"}))'), true)
  await act('fixture.close(fixture.tabStorage.session_workspaceByKey_ws_openAppKeys$()[0]);await fixture.appRouter.openApp("/napplet/"+reference)')
  await browser.until(() => evaluate('reports.length === 2'), 'reopened napplet')
  assert.equal(await evaluate('reports[1].previous'), '1')
  await browser.navigate(origin)
  await browser.until(() => evaluate('!!document.querySelector("napplet-frame iframe")'), 'restored window')
  // Observe via storage only after the real restored frame has incremented it.
  await browser.until(() => evaluate('Object.keys(localStorage).filter(key=>key.startsWith("local_nappletState_")).some(key=>Object.values(JSON.parse(localStorage.getItem(key))).includes("3"))'), 'reload persistence')
  await evaluate(`window.appId=${JSON.stringify(nappletDescriptor(event).appId)};window.reference=${JSON.stringify(nappletReference(event))};window.reports=[];window.reportErrors=[];addEventListener('message',event=>{if(event.data?.fixtureReport)reports.push(event.data);if(event.data?.fixtureError)reportErrors.push(event.data.fixtureError)});fixture.storage.session_workspaceByKey_ws_userPk$('bob')`)
  await browser.until(() => evaluate('reports.length || reportErrors.length'), 'account switch')
  assert.deepEqual(await evaluate('reportErrors'), [])
  assert.equal(await evaluate('reports[0].previous'), null)
  await evaluate('fixture.close(fixture.tabStorage.session_workspaceByKey_ws_openAppKeys$()[0])')
  await browser.navigate(`${origin}/napplet/${nappletReference(event)}`)
  await browser.until(() => evaluate('location.pathname === "/" && Object.keys(localStorage).filter(key=>key.startsWith("local_nappletState_bob_")).some(key=>Object.values(JSON.parse(localStorage.getItem(key))).includes("2"))'), 'direct napplet URL')
  await evaluate('fixture.location.pushState({}, "", "/napplets")')
  await browser.until(() => evaluate('location.pathname === "/"'), 'store URL consumed')
  await browser.until(catalogVisible, 'catalog visible after in-app navigation')
  await evaluate('fixture.location.back()')
  await browser.until(() => evaluate('location.pathname === "/"'), 'browser Back')
  await evaluate('fixture.location.forward()')
  await browser.until(() => evaluate('location.pathname === "/"'), 'browser Forward')
  await browser.until(catalogVisible, 'catalog visible after browser Forward')
  await evaluate(`window.appId=${JSON.stringify(nappletDescriptor(event).appId)}`)
  await act('await fixture.uninstall(fixture.storage["session_workspaceByKey_ws_appById_"+appId+"_appKeys$"]()[0],appId,"bob")')
  assert.equal(await evaluate('fixture.getInstallation(appId).then(Boolean)'), false)
  assert.equal(await evaluate('Object.keys(localStorage).some(key=>key.startsWith("local_nappletState_bob_"))'), false)
  console.log('Napplet browser checks passed: visible catalog on direct navigation/reload/Forward, real window/router, sandbox, optional domains, close/reopen, reload, account isolation, direct URLs, Back/Forward, uninstall.')
} catch (error) {
  await browser?.diagnose(diagnostics)
  throw error
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  stop()
}
