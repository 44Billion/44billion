import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import http from 'node:http'
import assert from 'node:assert/strict'
let fixtureServer
const profile = mkdtempSync('/tmp/bridge-chrome-')
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
const timeout = setTimeout(() => {
  console.error('Chrome verification timed out', errors)
  // Also stop a stalled fixture build, not only a browser awaiting CDP.
  esbuild.stop()
  fixtureServer?.closeAllConnections()
  fixtureServer?.close()
  chrome.kill()
  process.exitCode = 1
}, 90000)
try {
  const repo = fileURLToPath(new URL('../..', import.meta.url))
  // Keep the production bootstrap route, but serve test bundles on an isolated
  // port. No deployed app, relay, signer or existing browser profile is needed.
  const { default: appRouter } = await import('../../server/router/app-router.js')
  const blockedOrigins = new Set(['2.localhost'])
  fixtureServer = http.createServer(async (request, response) => {
    try {
      request.webUrl = new URL(request.url, `http://${request.headers.host}`)
      const pathname = request.webUrl.pathname
      // Withhold a cold support document to exercise the real five-second
      // timeout: origin 1 recovers automatically; origin 2 requires retry.
      if (pathname === '/~~napp' && (blockedOrigins.has(request.webUrl.hostname) ||
        (request.webUrl.hostname === '1.localhost' && request.webUrl.searchParams.get('retry') === '0'))) return
      const filename = { '/fixture.js': 'fixture.js', '/sw.js': 'sw.js' }[pathname]
      if (filename) {
        response.setHeader('Content-Type', 'text/javascript')
        response.end(readFileSync(path.join(profile, filename)))
      } else if (request.webUrl.hostname === 'localhost') {
        response.setHeader('Content-Type', 'text/html')
        response.end('<!doctype html><html><body><script type="module" src="/fixture.js"></script></body></html>')
      } else await appRouter.fetch(request, response)
    } catch (error) { response.writeHead(500).end(String(error)) }
  })
  await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve))
  const port = fixtureServer.address().port
  const stubs = {
    '#zones/vault-modal/index.js': 'export const useVaultActor=()=>({askVault(){throw Error("Unexpected vault request")}});export const useVaultModalStore=()=>({});export const tellVault=()=>{};export const flushQueuedVaultAcceptedMessages=()=>{}',
    '#zones/permission-dialog/index.js': 'export const usePermissionDialogStore=()=>({requestPermission(){throw Error("Unexpected permission request")}})',
    '#zones/confirmation-dialog/index.js': 'export const useConfirmationDialogStore=()=>({requestConfirmation(){throw Error("Unexpected confirmation")}})',
    '#zones/file-not-cached-dialog/index.js': 'export const getFileNotCachedText=key=>key;export const useFileNotCachedDialogStore=()=>({requestAction(details){fixture.dialogs.push(details);return new Promise(()=>{})}})'
  }
  const define = { IS_DEVELOPMENT: 'true', IS_PRODUCTION: 'false' }
  const plugins = [{
    name: 'bridge-test-environment',
    setup (build) {
      build.onResolve({ filter: /.*/ }, args => stubs[args.path] ? { path: args.path, namespace: 'fixture' } : undefined)
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], resolveDir: repo }))
      build.onLoad({ filter: /helpers\/window-message\/index\.js$/ }, args => ({ contents: readFileSync(args.path, 'utf8').replace("'localhost:10000'", JSON.stringify(`localhost:${port}`)) }))
      build.onLoad({ filter: /\.txt\.js$/ }, async args => {
        // Bundle the entry as source so this loader cannot recursively load itself.
        const result = await esbuild.build({ stdin: { contents: readFileSync(args.path, 'utf8'), resolveDir: path.dirname(args.path) }, bundle: true, format: 'iife', write: false, define, plugins })
        return { contents: `export default ${JSON.stringify(result.outputFiles[0].text)}` }
      })
    }
  }]
  const options = { absWorkingDir: repo, bundle: true, define, plugins, loader: { '.html': 'text', '.css': 'text', '.webp': 'dataurl', '.svg': 'text' } }
  await esbuild.build({ ...options, entryPoints: ['tests/browser/app-bridge-fixture.js'], format: 'esm', outfile: path.join(profile, 'fixture.js') })
  await esbuild.build({ ...options, entryPoints: ['src/service-workers/app/index.js'], format: 'iife', outfile: path.join(profile, 'sw.js') })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const cdp = (method, params) => send(method, params, sessionId)
  const evaluate = async expression => {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
    return response.result.value
  }
  const until = async (expression, message, ms = 4000) => {
    const deadline = Date.now() + ms
    do { if (await evaluate(expression)) return; await wait(50) } while (Date.now() < deadline)
    const details = await evaluate('({errors:window.fixtureErrors,dialogs:window.fixture?.dialogs,loaded:window.fixture?.loaded,bridge:window.fixture?.getAppBridgeState("0")&&{ready:fixture.getAppBridgeState("0").ready$(),size:fixture.getAppBridgeState("0").windows.size},frames:[...document.querySelectorAll("iframe")].map(f=>f.src),text:document.body.innerText})')
    assert.fail(`${message}: ${JSON.stringify(details)}`)
  }
  await cdp('Page.enable')
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.fixtureErrors=[];window.addEventListener("error",e=>fixtureErrors.push(String(e.error?.stack||e.message)));window.addEventListener("unhandledrejection",e=>fixtureErrors.push(String(e.reason?.stack||e.reason)))' })
  await cdp('Page.navigate', { url: `http://localhost:${port}` })
  const bridge = 'fixture.getAppBridgeState("0")'
  const loaded = key => `fixture.instanceMetadata.getMetadata('${key}')?.isLoaded`
  await until('window.fixture?.loaded.some(item=>item.metadata.instanceKey===\'window\')', 'first window loads through a cold bridge', 12000)
  await until(loaded('window'), 'window document handshake')
  assert.equal(await evaluate(`${bridge}.ready$()`), true)
  assert.equal(await evaluate(`${bridge}.retryCount$()`), 0, 'ready must not unregister the last window')
  await evaluate(`fixture.originalBridge=${bridge};fixture.originalPort=${bridge}.currentPort;fixture.originalFrame=document.querySelector('app-window iframe');fixture.originalDocument=fixture.loaded[0].token`)
  const setVisibility = (key, value) => evaluate(`fixture.tabStorage.session_appByKey_${key}_visibility$('${value}')`)
  const checkLivePort = async (width = 950) => {
    await evaluate(`document.querySelector('app-window iframe').contentWindow.postMessage({code:'FIXTURE_MIN_WIDTH',width:${width}},'http://0.localhost:${port}')`)
    await until(`document.querySelector('app-window iframe').style.width==='${width}px'`, 'app MessagePort remains usable')
  }
  await checkLivePort()
  await evaluate(`document.querySelector('app-window iframe').contentWindow.postMessage({code:'FIXTURE_NAVIGATE',path:'/next'},'http://0.localhost:${port}')`)
  await until('fixture.loaded.length===2', 'app navigation renews document handshake')
  await until("fixture.storage.session_appByKey_window_route$()==='/next'", 'route persisted through the app port')
  await checkLivePort(1000)
  await setVisibility('window', 'minimized')
  assert.equal(await evaluate(loaded('window')), true, 'minimize preserves loaded document')
  await setVisibility('window', 'open')
  await checkLivePort(1050)
  await setVisibility('peer', 'open')
  await until(loaded('peer'), 'second window shares ready bridge')
  assert.equal(await evaluate(`${bridge}.currentPort===fixture.originalPort`), true, 'membership updates do not restart bridge')
  await setVisibility('window', 'closed')
  await until(`!${loaded('window')}`, 'closed window disconnects document')
  assert.equal(await evaluate(`${bridge}.ready$() && ${bridge}.windows.size===1`), true)
  await setVisibility('peer', 'closed')
  await until(`${bridge}.windows.size===0 && !${bridge}.currentPort && fixture.getAppBridgeSpecs()().length===0`, 'last close tears down bridge')
  await setVisibility('window', 'open')
  await until(loaded('window'), 'same window reopens through warm service worker')
  assert.equal(await evaluate(`${bridge}===fixture.originalBridge`), true)
  await checkLivePort(1100)
  assert.equal(await evaluate('fixture.storage.session_appByKey_window_route$()'), '/', 'close resets route')
  await evaluate(`fixture.retryAppBridge(${bridge})`)
  await until(`${bridge}.retryCount$()===1 && ${loaded('window')}`, 'explicit retry creates a fresh trusted document')
  await checkLivePort(1150)
  assert.equal(await evaluate(`${bridge}.currentPort!==fixture.originalPort`), true)
  await setVisibility('window', 'closed')
  await evaluate('fixture.storage.local_widgets$({widget:{appId:fixture.appId,wsKey:\'ws\',row:0,col:0,desired:{w:2,h:2},pinnedRoute:\'\',createdAt:1,updatedAt:1}})')
  await until(loaded('widget'), 'standalone widget loads through real bridge')
  await setVisibility('window', 'open')
  await until(loaded('window'), 'window joins widget bridge')
  await setVisibility('window', 'closed')
  assert.equal(await evaluate(loaded('widget')), true)
  await evaluate('fixture.storage.local_widgets$({})')
  await until(`${bridge}.windows.size===0 && !${bridge}.currentPort`, 'removing last widget releases bridge')
  await evaluate('fixture.state.single$(true)')
  await until('fixture.loaded.some(item=>item.metadata.instanceKey.startsWith("single-napp:"))', 'embedded launcher loads as the only instance')
  assert.equal(await evaluate('fixture.AppUpdater.singleNappOpenCount()'), 1, 'one admission for the lifetime of an embedded instance')
  await evaluate(`fixture.retryAppBridge(${bridge})`)
  await until(`${bridge}.ready$() && fixture.loaded.filter(item=>item.metadata.instanceKey.startsWith('single-napp:')).length===2`, 'embedded retry reuses admission')
  assert.equal(await evaluate('fixture.AppUpdater.singleNappOpenCount()'), 1)
  await evaluate('fixture.state.single$(false)')
  await until(`${bridge}.windows.size===0 && !${bridge}.currentPort`, 'embedded unmount releases bridge')
  assert.equal(await evaluate('fixture.AppUpdater.singleNappOpenCount()'), 0)
  assert.deepEqual(await evaluate('fixture.dialogs'), [])
  await evaluate(`fixture.disposeAppBridge(${bridge});fixture.state.windows$(false)`)
  await wait(100)
  await evaluate('fixture.state.windows$(true)')
  await setVisibility('window', 'open')
  await until(loaded('window'), 'disposed subdomain gets a new working bridge')
  assert.equal(await evaluate(`${bridge}.bridgeId!==fixture.originalBridge.bridgeId`), true)
  await checkLivePort(1200)
  await setVisibility('window', 'closed')
  await evaluate('fixture.storage["session_subdomainByUserAndApp_"+fixture.userPk+"_"+fixture.appId+"$"]("1")')
  await setVisibility('window', 'open')
  await until(loaded('window'), 'cold bridge recovers after one automatic retry', 9000)
  assert.equal(await evaluate('fixture.getAppBridgeState("1").retryCount$()'), 1)
  assert.deepEqual(await evaluate('fixture.dialogs'), [])
  await setVisibility('window', 'closed')
  await evaluate('fixture.storage["session_subdomainByUserAndApp_"+fixture.userPk+"_"+fixture.appId+"$"]("2")')
  await setVisibility('window', 'open')
  await until('fixture.dialogs.length===1', 'persistent failure escalates once to recovery dialog', 12000)
  assert.equal(await evaluate('fixture.getAppBridgeState("2").retryCount$()'), 1, 'automatic retries are bounded')
  blockedOrigins.delete('2.localhost')
  await evaluate('fixture.retryAppBridge(fixture.getAppBridgeState("2"))')
  await until(loaded('window'), 'manual retry recovers after timeout dialog')
  await setVisibility('window', 'closed')
  await until('fixture.getAppBridgeState("2").windows.size===0 && !fixture.getAppBridgeState("2").currentPort', 'recovered bridge still cleans up')
  assert.deepEqual(await evaluate('fixtureErrors'), [])
  console.log('Chrome: real cold/warm bridge, app navigation and live ports, minimize/close/reopen, shared windows/widgets, automatic/manual retries, bounded timeout recovery and embedded lifecycle passed')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  fixtureServer?.closeAllConnections()
  fixtureServer?.close()
  esbuild.stop()
  const removeProfile = () => rmSync(profile, { recursive: true, force: true })
  if (chrome.exitCode !== null || chrome.signalCode !== null) removeProfile()
  else {
    chrome.once('exit', removeProfile)
    chrome.kill()
  }
}
