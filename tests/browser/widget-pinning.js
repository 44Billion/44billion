import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import http from 'node:http'
import assert from 'node:assert/strict'
import checkGestures from './widget-gesture-regressions.js'
import checkMenus from './widget-menu-regressions.js'
let fixtureServer
const profile = mkdtempSync('/tmp/widget-chrome-')
const chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--allow-file-access-from-files', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
let seq = 0; let buffer = ''; let errors = ''
for (const pipe of [chrome.stdio[3], chrome.stdio[4]]) pipe.on('error', () => {})
const pending = new Map()
chrome.stderr.on('data', b => { errors = (errors + b).slice(-3000) })
chrome.on('exit', code => { for (const p of pending.values()) p.reject(new Error(`Chrome exited ${code}: ${errors}`)); pending.clear() })
chrome.stdio[4].on('data', b => {
  buffer += b.toString()
  let end
  while ((end = buffer.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
    if (pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id)
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result)
    }
  }
})
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject })
  chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0')
})
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const timeout = setTimeout(() => { console.error('Chrome verification timed out', errors); chrome.kill(); process.exitCode = 1 }, process.argv.includes('--menus') ? 90000 : 45000)
;(async () => {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const cdp = (method, params) => send(method, params, sessionId)
  const evaluate = async expression => {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
    return response.result.value
  }
  const repo = fileURLToPath(new URL('../..', import.meta.url))
  const source = readFileSync(path.join(repo, 'src/components/zones/screen/index.js'), 'utf8')
  const start = source.indexOf('const style$ = useComputed(() => /* css */`') + 'const style$ = useComputed(() => /* css */'.length
  const template = source.slice(start, source.indexOf('`)', start) + 1)
  const background = source.slice(source.indexOf("id='windows-background'"))
  const backgroundTemplate = background.slice(background.indexOf('`'), background.indexOf('`}', background.indexOf('`')) + 1)
  const stubs = {
    'fixture-screen-style': `import {cssVars} from '#assets/styles/theme.js'; export const screenStyle = system => { const isSystemRoute$=()=>system;const isToolbarHidden$=()=>false;return ${template} }; export const backgroundStyle = ${backgroundTemplate}`,
    '#zones/vault-modal/index.js': 'export const useVaultActor = () => ({askVault(){}})',
    '#zones/permission-dialog/index.js': 'export const usePermissionDialogStore = () => ({requestPermission(){}})',
    '#zones/confirmation-dialog/index.js': 'export const useConfirmationDialogStore = () => ({requestConfirmation(){}})',
    '#i18n/asset-budget.js': 'export const getAssetBudgetConfirmation = () => ({})',
    '#services/app-asset-budget/index.js': 'export const formatAssetBudgetBytes = () => ""',
    '#helpers/subdomain-mapping.js': 'export const allocateAppSubdomain = () => {}; export const subdomainStorage = () => new Proxy({}, {get:(_,key)=>()=>JSON.parse(localStorage.getItem(key.slice(0,-1)))??undefined}); export const isSubdomainStorageKey = key => key.startsWith("session_subdomain")',
    '#i18n/index.js': 'export const getT = () => key => key',
    '#helpers/window-message/index.js': 'export const tell = (port,message) => port.postMessage(message)',
    '#helpers/window-message/app-bridge-registry.js': `
      import {toSignal} from '#f';
      const bridge = { windows:new Map(), ready$:toSignal(true), error$:toSignal(null) };
      export const ensureAppBridgeState=()=>bridge;
      export const registerAppBridgeWindow=(state,entry)=>{
        fixture.registrations[entry.appKey]=entry;
        bridge.windows.set(entry.appKey,{widgetPort:{postMessage(message){document.querySelectorAll('iframe').forEach(frame=>{
          if(frame.dataset.key===entry.appKey)frame.contentWindow.postMessage(message,'*')
        })}}});
        return ()=>{delete fixture.registrations[entry.appKey];bridge.windows.delete(entry.appKey)}
      }`,
    '#helpers/window-message/app-bridge.js': `
      import {instanceMetadata} from '#services/instance-metadata/index.js';
      export const APP_PENDING_INDICATOR_DELAY_MS=50;
      export const initAppWindow=(state,options)=>{
        fixture.starts[options.appKey]=(fixture.starts[options.appKey]||0)+1;
        const frame=options.appIframeRef$();frame.dataset.key=options.appKey;
        const connection=instanceMetadata.connect({instanceKey:options.appKey,appId:'app',userPk:'user',isWidget:true},()=>{});
        frame.addEventListener('load',()=>{
          const win=frame.contentWindow;
          const client=fixture.createWidgetDragClient({window:win,document:win.document,isWidget:()=>true,sendDrag:(op,x,y,screenX,screenY)=>fixture.registrations[options.appKey]?.onWidgetDrag({op,x,y,screenX,screenY})});
          win.addEventListener('message',e=>{if(e.data.code==='WIDGET_SELECT_MODE')client.setSelectMode(e.data.payload.enabled)});
          options.onAppReady();
        },{once:true});
        options.appIframeSrc$('fixture-frame.html');
        return connection.disconnect;
      }`
  }
  if (process.argv.includes('--menus')) {
    stubs['#i18n/index.js'] = "export const getT = locales => key => locales?.[key]?.['pt-BR'] ?? key"
  }
  let fixtureUrl = 'file://' + path.join(profile, 'fixture.html')
  if (process.argv.includes('--gestures')) {
    fixtureServer = http.createServer((request, response) => {
      const filename = new URL(request.url, 'http://localhost').pathname.slice(1)
      if (!['fixture.html', 'fixture-frame.html', 'frame.js'].includes(filename)) { response.writeHead(404).end(); return }
      response.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : 'text/html')
      response.end(readFileSync(path.join(profile, filename)))
    })
    await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve))
    const port = fixtureServer.address().port
    fixtureUrl = `http://127.0.0.1:${port}/fixture.html`
    stubs['#helpers/window-message/app-bridge.js'] = `
      import {instanceMetadata} from '#services/instance-metadata/index.js';
      export const APP_PENDING_INDICATOR_DELAY_MS=50;
      export const initAppWindow=(state,options)=>{
        const frame=options.appIframeRef$();frame.dataset.key=options.appKey;
        const connection=instanceMetadata.connect({instanceKey:options.appKey,appId:'app',userPk:'user',isWidget:true},()=>{});
        const receive=event=>{
          if(event.source!==frame.contentWindow)return;
          if(event.data.code==='ready')options.onAppReady();
          if(event.data.code==='drag')fixture.registrations[options.appKey]?.onWidgetDrag(event.data.payload);
        };
        window.addEventListener('message',receive);
        options.appIframeSrc$('http://localhost:${port}/fixture-frame.html');
        return ()=>{connection.disconnect();window.removeEventListener('message',receive)};
      }`
    await esbuild.build({
      absWorkingDir: repo,
      stdin: {
        contents: `
        import {createWidgetDragClient} from './src/helpers/window-message/widget-drag-client.js';
        const client=createWidgetDragClient({window,document,isWidget:()=>true,sendDrag:(op,x,y,screenX,screenY)=>parent.postMessage({code:'drag',payload:{op,x,y,screenX,screenY}},'${new URL(fixtureUrl).origin}')});
        window.addEventListener('message',event=>{
          if(event.source!==parent)return;
          if(event.data.code==='WIDGET_SELECT_MODE')client.setSelectMode(event.data.payload.enabled);
          if(event.data.code==='fixture-reset')window.dispatchEvent(new Event('pagehide'));
        });
        parent.postMessage({code:'ready'},'${new URL(fixtureUrl).origin}');
      `,
        resolveDir: repo
      },
      bundle: true,
      outfile: path.join(profile, 'frame.js')
    })
  }
  await esbuild.build({
    absWorkingDir: repo,
    entryPoints: ['tests/browser/widget-pinning-fixture.js'],
    bundle: true,
    outfile: path.join(profile, 'fixture.js'),
    define: { IS_DEVELOPMENT: 'false' },
    plugins: [{
      name: 'fixture-bridge',
      setup (build) {
        build.onResolve({ filter: /.*/ }, args => stubs[args.path] ? { path: args.path, namespace: 'fixture' } : undefined)
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], resolveDir: repo }))
      }
    }]
  })
  writeFileSync(path.join(profile, 'fixture.html'), '<!doctype html><html><body></body></html>')
  writeFileSync(path.join(profile, 'fixture-frame.html'), '<!doctype html><html><body style="margin:0"><a href="#activated">Link</a><div style="height:100vh;overflow:auto"><p style="height:400vh">Scrollable text</p></div>' + (fixtureServer ? '<script src="frame.js"></script>' : '') + '</body></html>')
  await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false })
  await cdp('Page.navigate', { url: fixtureUrl })
  await wait(100)
  const widget = (row, col, w, h, isPinned = false) => ({ appId: 'app', wsKey: 'ws', row, col, desired: { w, h }, pinnedRoute: '', isPinned, createdAt: 1, updatedAt: 1 })
  const data = {
    session_workspaceKeys: ['ws', 'other'],
    session_openWorkspaceKeys: ['ws', 'other'],
    session_workspaceByKey_ws_userPk: 'user',
    session_workspaceByKey_other_userPk: 'user',
    session_workspaceByKey_ws_pinnedAppIds: ['app'],
    session_workspaceByKey_other_pinnedAppIds: ['app'],
    session_workspaceByKey_ws_appById_app_appKeys: ['window'],
    session_subdomainByUserAndApp_user_app: '1',
    local_widgets: { tiny: widget(0, 0, 1, 1, true), wide: widget(0, 2, 3, 1), tall: widget(2, 0, 1, 3), peer: { ...widget(0, 0, 1, 1, true), wsKey: 'other' } }
  }
  await evaluate(`localStorage.clear();sessionStorage.clear();for(const [key,value] of Object.entries(${JSON.stringify(data)}))localStorage.setItem(key,JSON.stringify(value));window.fixtureErrors=[];window.addEventListener('error',e=>fixtureErrors.push(String(e.error?.stack||e.message)));console.error=(...args)=>fixtureErrors.push(args.map(String).join(' '))`)
  await evaluate(readFileSync(path.join(profile, 'fixture.js'), 'utf8'))
  await wait(450)
  assert.deepEqual(await evaluate('fixtureErrors'), [])
  const root = key => `document.querySelector('iframe[data-key="${key}"]').closest('.widget-window-root')`
  const metadata = key => evaluate(`fixture.instanceMetadata.getMetadata('${key}')`)
  const gesture = async (key, op, extra = {}) => {
    await evaluate(`fixture.registrations.${key}.onWidgetDrag(${JSON.stringify({ op, x: 12, y: 12, ...extra })})`)
    await wait(60)
  }
  const select = async key => { await gesture(key, 'start'); await gesture(key, 'end') }
  const hit = key => evaluate(`(()=>{const r=${root(key)}.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.tagName})()`)
  if (process.argv.includes('--gestures')) {
    await checkGestures({ cdp, evaluate, wait, root, select })
    return
  }
  if (process.argv.includes('--menus')) {
    await evaluate(`(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(readFileSync(path.join(repo, 'src/assets/styles/reset.css'), 'utf8'))};document.head.append(style)})()`)
    await checkMenus({ cdp, evaluate, wait, root, select })
    return
  }
  await evaluate('window.framesBefore=[...document.querySelectorAll(\'iframe\')].map(f=>({frame:f,win:f.contentWindow,doc:f.contentDocument}));fixture.instanceMetadata.connect({instanceKey:\'window\',appId:\'app\',userPk:\'user\'},()=>{});fixture.state.window$(true);fixture.state.system$(true)')
  await wait(120)
  assert.equal(await hit('tiny'), 'IFRAME', 'pin above windows and system')
  assert.equal(await hit('wide'), 'DIV', 'normal widget behind system')
  assert.equal((await metadata('tiny')).isVisible, true)
  assert.equal((await metadata('wide')).isVisible, false)
  await select('tiny')
  assert.equal(await evaluate('fixture.automatic$().widgetKey'), 'tiny')
  assert.equal(await hit('wide'), 'IFRAME', 'automatic reveal exposes normal widgets')
  assert.equal((await metadata('window')).isVisible, false)
  assert.equal((await metadata('wide')).isVisible, true)
  assert.equal(await evaluate(`${root('tiny')}.querySelectorAll('.widget-remove-button').length`), 1)
  await evaluate(`${root('tiny')}.querySelector('.widget-remove-button').click()`)
  await wait(180)
  assert.equal(await evaluate(`${root('tiny')}.querySelector('dialog').matches(':popover-open')`), true)
  const menuFits = () => evaluate('(()=>{const r=document.querySelector(\'dialog:popover-open\').getBoundingClientRect();return r.width>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()')
  assert.equal(await menuFits(), true, 'anchored menu stays in viewport')
  assert.equal(await evaluate('(()=>{const e=document.querySelector(\'dialog:popover-open\');const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+10,r.y+10))})()'), true, 'menu is above pin and receives events')
  await wait(4200)
  assert.equal(await evaluate(`${root('tiny')}.classList.contains('widget-window-selected')`), true, 'menu pauses selection timeout')
  await evaluate('document.querySelector(\'dialog:popover-open button\').click()')
  await wait(120)
  assert.equal((await metadata('tiny')).isPinned, false)
  assert.equal(await evaluate('fixture.automatic$().widgetKey'), 'tiny', 'unpin preserves reveal')
  await select('wide')
  assert.equal(await evaluate('fixture.automatic$().widgetKey'), 'wide', 'editing transfers reveal')
  assert.equal(await evaluate(`${root('wide')}.querySelectorAll('.widget-remove-button').length`), 1, 'wide one-row widget is compact')
  await select('tall')
  assert.equal(await evaluate(`${root('tall')}.querySelectorAll('.widget-remove-button').length`), 1)
  await evaluate(`${root('tall')}.querySelector('.widget-remove-button').click()`)
  await wait(180)
  await evaluate(`${root('tall')}.querySelector('.widget-action-item').click()`)
  await wait(120)
  assert.equal(await evaluate('fixture.storage.local_widgets$().tall.isPinned'), true)
  assert.equal((await metadata('wide')).otherInstances.find(r => r.instanceKey === 'tall').isPinned, true)
  assert.equal(await evaluate('framesBefore.every(({frame,win,doc})=>frame.isConnected&&frame.contentWindow===win&&frame.contentDocument===doc)'), true, 'pin changes preserve iframe, window and document')
  assert.deepEqual(await evaluate('fixture.starts'), { tiny: 1, wide: 1, tall: 1 })
  await evaluate('window.dispatchEvent(new KeyboardEvent(\'keydown\',{key:\'Escape\'}))')
  await wait(80)
  assert.equal(await evaluate('fixture.automatic$()'), null)
  assert.equal((await metadata('wide')).isVisible, false)
  assert.equal((await metadata('tall')).isVisible, true)
  // Native modal top layer also stays above the pin.
  await evaluate('(()=>{const dialog=document.createElement(\'dialog\');dialog.id=\'test-modal\';dialog.textContent=\'Modal\';document.body.append(dialog);dialog.showModal()})()')
  assert.equal(await evaluate('(()=>{const d=document.getElementById(\'test-modal\');const r=d.getBoundingClientRect();return d===document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)})()'), true)
  await evaluate("document.getElementById('test-modal').remove();fixture.manual$(true)")
  await select('tall')
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")
  assert.equal(await evaluate('fixture.manual$()'), true, 'automatic cleanup preserves manual reveal')
  await evaluate('fixture.state.system$(false);fixture.state.window$(false);fixture.manual$(false)')
  await wait(300)
  assert.equal(await evaluate('document.elementFromPoint(600,500).id'), 'widgets-scroll', 'background cannot intercept free-area swipe')

  // Exercise both CSS anchors and the old-browser positioning branch at the
  // bottom/right edge, using the same a-menu rendered by widget-window.
  await evaluate('fixture.storage.local_widgets$(all=>({...all,tiny:{...all.tiny,row:8,col:11}}))')
  await wait(100)
  for (const fallback of [false, true]) {
    const key = fallback ? 'fallback' : 'tiny'
    if (fallback) {
      await evaluate("window.originalSupports=CSS.supports;CSS.supports=(...args)=>args[0]==='position-anchor'?false:originalSupports(...args);fixture.storage.local_widgets$(all=>({...all,tiny:{...all.tiny,col:0},fallback:{...all.tiny}}))")
      await wait(150)
    }
    await select(key)
    await evaluate(`${root(key)}.querySelector('.widget-remove-button').click()`)
    await wait(180)
    assert.equal(await menuFits(), true, fallback ? 'fallback fits near edges' : 'anchors flip near edges')
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")
    await wait(60)
    assert.equal(await evaluate(`${root(key)}.classList.contains('widget-window-selected')`), true, 'Escape closes menu before selection')
    if (fallback) await evaluate('CSS.supports=originalSupports')
  }

  const mouse = (type, x, y) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
  await select('tall')
  for (const [node, dx, dy, dimension] of [['right', 61, 0, 'w'], ['left', -61, 0, 'w'], ['bottom', 0, 61, 'h'], ['top', 0, -61, 'h']]) {
    // Leave room for each edge to expand, including the left/top edges.
    await evaluate('fixture.storage.local_widgets$(all=>({...all,tall:{...all.tall,row:3,col:3}}))')
    await wait(80)
    const before = await evaluate(`fixture.storage.local_widgets$().tall.desired.${dimension}`)
    const point = await evaluate(`(()=>{const r=${root('tall')}.querySelector('.widget-resize-node.${node}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await mouse('mousePressed', point.x, point.y)
    await mouse('mouseMoved', point.x + dx, point.y + dy)
    await mouse('mouseReleased', point.x + dx, point.y + dy)
    await wait(80)
    assert.equal(await evaluate(`fixture.storage.local_widgets$().tall.desired.${dimension}`), before + 1, `resize ${node}`)
    assert.equal(await evaluate(`${root('tall')}.classList.contains('widget-window-dragging')`), false)
  }

  // Real Chrome touch events reach the actual injected drag client inside the
  // scaled iframe. This is emulation, not a physical Android acceptance test.
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));fixture.state.system$(true)")
  await wait(100)
  // Keep the gesture away from controls: Chrome expands touch targeting beyond their visual borders.
  const touchPoint = await evaluate(`(()=>{const r=${root('tall')}.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+80}})()`)
  await mouse('mousePressed', touchPoint.x, touchPoint.y)
  await wait(700)
  assert.equal(await evaluate(`${root('tall')}.classList.contains('widget-window-dragging')`), true, 'mouse longpress starts drag inside scaled iframe')
  await mouse('mouseReleased', touchPoint.x, touchPoint.y)
  await wait(100)
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")
  await wait(80)
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  const touch = (type, point = touchPoint) => cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ ...point, radiusX: 1, radiusY: 1, force: 1, id: 1 }] })
  await touch('touchStart')
  await wait(700)
  assert.equal(await evaluate(`${root('tall')}.classList.contains('widget-window-dragging')`), true, 'initial longpress starts drag')
  await touch('touchEnd')
  await wait(100)
  await touch('touchStart')
  await wait(70)
  assert.equal(await evaluate(`${root('tall')}.classList.contains('widget-window-dragging')`), true, 'selected touch starts immediately')
  await wait(800)
  assert.equal(await evaluate(`${root('tall')}.classList.contains('widget-window-dragging')`), true, 'stationary touch survives longpress')
  await touch('touchMove', { x: touchPoint.x + 65, y: touchPoint.y })
  await touch('touchEnd')
  await wait(100)
  assert.equal(await evaluate(`${root('tall')}.classList.contains('widget-window-selected')`), true)
  assert.equal(await evaluate('document.querySelector(\'iframe[data-key="tall"]\').contentDocument.querySelector(\'div\').scrollTop'), 0)
  assert.equal(await evaluate('document.querySelector(\'iframe[data-key="tall"]\').contentWindow.location.hash'), '')
  await evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))")
  assert.equal(await evaluate('fixture.automatic$()'), null, 'hidden tab ends automatic reveal')
  assert.equal((await metadata('tall')).isVisible, false)
  await evaluate("delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));fixture.state.system$(false)")
  await wait(120)

  // Swiping the free grid still scrolls and snaps after removing the
  // intermediate stacking contexts. Pins remain clipped to their own page.
  await evaluate('fixture.storage.local_widgets$(all=>({...all,far:{...all.tiny,col:24,row:0,isPinned:true}}))')
  await wait(100)
  assert.equal(await evaluate('document.elementFromPoint(650,80).id'), 'widgets-scroll')
  await touch('touchStart', { x: 650, y: 80 })
  for (let x = 600; x >= 250; x -= 50) {
    await touch('touchMove', { x, y: 80 })
    await wait(25)
  }
  await touch('touchEnd')
  await wait(500)
  assert.ok(await evaluate("document.getElementById('widgets-scroll').scrollLeft") > 0, 'native free-area swipe scrolls')
  assert.equal((await metadata('tall')).isVisible, false, 'off-page pin is invisible')
  assert.equal(await evaluate(`${root('tall')}.classList.contains('widget-window-pinned')`), false)
  assert.equal(await evaluate("(()=>{const s=document.getElementById('widgets-scroll');s.scrollTo({left:0,behavior:'instant'});return getComputedStyle(s).scrollSnapType})()"), 'x mandatory')
  await wait(150)
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: false })

  // The same drag draft and edge timer carry the pinned widget to another
  // page; its persisted flag travels with the widget.
  await evaluate('fixture.storage.local_widgets$(all=>({...all,tiny:{...all.tiny,row:0,col:0,isPinned:true}}));fixture.state.system$(true)')
  await wait(120)
  await gesture('tiny', 'start', { screenX: 0, screenY: 0 })
  await gesture('tiny', 'move', { screenX: 720, screenY: 0 })
  await wait(700)
  assert.ok(await evaluate("document.getElementById('widgets-scroll').scrollLeft") > 0, 'drag edge timer changes page')
  assert.equal(await evaluate("document.querySelector('.widgets-grid-dots').classList.contains('visible')"), true)
  await gesture('tiny', 'end', { screenX: 720, screenY: 0 })
  await wait(150)
  assert.equal((await metadata('tiny')).isPinned, true)
  assert.equal((await metadata('tiny')).isVisible, true)
  assert.equal(await evaluate('framesBefore[0].frame===document.querySelector(\'iframe[data-key="tiny"]\')'), true)
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));document.getElementById('widgets-scroll').scrollTo({left:0,behavior:'instant'})")
  await wait(120)

  // StorageEvent updates the shared preference without aggregating another
  // launcher's execution state.
  const second = await send('Target.createTarget', { url: 'file://' + path.join(profile, 'fixture.html'), background: true })
  const secondSession = await send('Target.attachToTarget', { targetId: second.targetId, flatten: true })
  await wait(100)
  await send('Runtime.evaluate', { expression: "const all=JSON.parse(localStorage.getItem('local_widgets'));all.peer.isPinned=false;localStorage.setItem('local_widgets',JSON.stringify(all))" }, secondSession.sessionId)
  await wait(120)
  const peer = (await metadata('tall')).otherInstances.find(r => r.instanceKey === 'peer')
  assert.deepEqual(peer, { instanceKey: 'peer', isWidget: true, isPinned: false, isLoaded: false, isVisible: false })
  await send('Target.closeTarget', { targetId: second.targetId })
  await evaluate('fixture.state.system$(true)')
  await select('tall')
  await evaluate(`${root('tall')}.querySelector('[aria-label="Remove Widget"]').click()`)
  await wait(100)
  assert.equal(await evaluate('fixture.automatic$()'), null, 'removing selected owner releases reveal')
  assert.equal(await evaluate("document.querySelector('iframe[data-key=\"tall\"]')===null"), true)
  await evaluate('fixture.storage.local_widgets$(all=>({...all,fallback:{...all.fallback,isPinned:true}}))')
  await wait(80)
  await select('fallback')
  assert.equal(await evaluate('fixture.automatic$().widgetKey'), 'fallback')
  await evaluate("fixture.tabStorage.session_tabWorkspaceKeys$(['other','ws'])")
  await wait(150)
  assert.equal(await evaluate('fixture.automatic$()'), null, 'workspace switch releases owner')
  assert.equal(await evaluate("document.querySelector('iframe[data-key=\"tall\"]')===null"), true)
  console.log('Chrome: stacking, menus/anchors/fallback, resize (four edges), touch drag/swipe, page clipping/edge flip, reveal lifecycle, iframe continuity and cross-tab metadata passed')
  assert.deepEqual(await evaluate('fixtureErrors'), [])
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { clearTimeout(timeout); fixtureServer?.close(); chrome.kill(); chrome.once('exit', () => rmSync(profile, { recursive: true, force: true })) })
