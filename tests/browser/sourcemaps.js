import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { SourceMap } from 'node:module'
import { launchChrome } from './runtime/chrome.js'

process.env.NODE_ENV = 'production'
const { default: router } = await import('../../server/router/index.js')
const root = new URL('../../dist/44billion/', import.meta.url)
const codeFor = name => readFile(new URL(name, root), 'utf8')
const urlFor = code => code.match(/\/\/# sourceMappingURL=(\S+)\s*$/)[1]
const mapFor = code => readFile(new URL(urlFor(code).slice(1), root), 'utf8').then(JSON.parse)
const appWorker = await codeFor('app-sw.js')
const workerMap = await mapFor(appWorker)
const injectedModule = workerMap.sourcesContent[workerMap.sources.indexOf('src/scripts/app-page-loader.txt.js')]
const injected = JSON.parse(injectedModule.slice('export default '.length).replace(/;\s*$/, ''))
const requests = []
const server = createServer(async (req, res) => {
  try {
    req.webUrl = new URL(req.url, `http://${req.headers.host}`)
    req.subdomain = req.webUrl.hostname === 'localhost' ? '' : req.webUrl.hostname.split('.')[0]
    if (req.webUrl.pathname.startsWith('/~~sourcemaps/')) requests.push(req.webUrl.href)
    if (req.subdomain === '123' && req.webUrl.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>Injected bridge test</title><script>window.observedMessages=[];addEventListener("message",e=>observedMessages.push(e.data?.code))</script><script>' + injected + '</script>')
      return
    }
    await router.fetch(req, res)
    if (!res.writableEnded) res.writeHead(404).end()
  } catch (error) { console.error(error); if (!res.headersSent) res.writeHead(500); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const origin = `http://localhost:${port}`
const appOrigin = `http://123.localhost:${port}`
const parsed = []
const pauses = []
let browser
const browserErrors = []
try {
  browser = await launchChrome({
    onEvent: event => {
      if (event.method === 'Debugger.scriptParsed') parsed.push({ ...event.params, sessionId: event.sessionId })
      if (event.method === 'Debugger.paused') {
        pauses.push(event)
        browser.send('Debugger.resume', {}, event.sessionId).catch(error => browserErrors.push(error))
      }
    }
  })
  await browser.send('Debugger.enable', {}, browser.sessionId)
  const app = await codeFor('app.js')
  const location = (code, offset) => {
    const before = code.slice(0, offset).split('\n')
    return { lineNumber: before.length - 1, columnNumber: before.at(-1).length }
  }
  const mainOffset = app.indexOf('localStorage.getItem("storage_version")')
  assert.ok(mainOffset >= 0)
  const mainPoint = location(app, mainOffset)
  const mainBreakpoint = await browser.send('Debugger.setBreakpointByUrl', { url: origin + '/app.js', ...mainPoint }, browser.sessionId)
  await browser.navigate(origin)
  await browser.until(() => pauses.find(event => event.params.hitBreakpoints?.includes(mainBreakpoint.breakpointId)), 'launcher breakpoint')
  const mainScript = await browser.until(() => parsed.find(script => script.url === origin + '/app.js'), 'launcher map discovery')
  assert.equal(mainScript.sourceMapURL, urlFor(app))
  assert.equal(new SourceMap(await mapFor(app)).findEntry(mainPoint.lineNumber, mainPoint.columnNumber).originalSource, 'src/components/app.js')
  await browser.until(() => browser.evaluate('!!navigator.serviceWorker.controller', origin), 'launcher service worker')

  async function assertMapFetch (pageOrigin, mapUrl) {
    const count = requests.length
    const result = await browser.evaluate(`fetch(${JSON.stringify(mapUrl)}).then(async r=>({status:r.status,type:r.headers.get('content-type'),cache:r.headers.get('cache-control'),map:await r.json()}))`, pageOrigin)
    assert.equal(result.status, 200)
    assert.equal(result.type, 'application/json')
    assert.equal(result.cache, 'no-store')
    assert.ok(result.map.sourcesContent.length > 0)
    assert.ok(requests.length > count, 'map goes to the network')
    assert.equal(await browser.evaluate('caches.keys().then(async keys=>(await Promise.all(keys.map(k=>caches.open(k).then(c=>c.keys())))).flat().some(r=>new URL(r.url).pathname.startsWith(\'/~~sourcemaps/\')))', pageOrigin), false)
  }
  await assertMapFetch(origin, mainScript.sourceMapURL)
  // Also exercise a minified dependency chunk through Chrome's discovered map URL.
  const chunk = await browser.until(() => parsed.find(script => script.url.startsWith(origin + '/chunks/') && script.sourceMapURL), 'chunk map discovery')
  await assertMapFetch(origin, chunk.sourceMapURL)

  async function workerBreakpoint (workerOrigin, code, marker, source, expression) {
    const info = await browser.until(async () => (await browser.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url === workerOrigin + '/sw.js'), 'worker target')
    // Attach only after activation; never pause a worker during startup/fetch.
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
    await browser.send('Debugger.enable', {}, sessionId)
    const script = await browser.until(() => parsed.find(script => script.sessionId === sessionId && script.url === info.url), 'worker map discovery')
    assert.equal(script.sourceMapURL, urlFor(code))
    const offset = code.indexOf(marker)
    assert.ok(offset >= 0)
    const point = location(code, offset)
    const { breakpointId } = await browser.send('Debugger.setBreakpoint', { location: { scriptId: script.scriptId, ...point } }, sessionId)
    await browser.send('Runtime.evaluate', { expression, awaitPromise: true }, sessionId)
    await browser.until(() => pauses.find(event => event.params.hitBreakpoints?.includes(breakpointId)), 'worker breakpoint')
    assert.equal(new SourceMap(await mapFor(code)).findEntry(point.lineNumber, point.columnNumber).originalSource, source)
    await browser.send('Debugger.removeBreakpoint', { breakpointId }, sessionId)
    await assertMapFetch(workerOrigin, script.sourceMapURL)
  }
  const launcherWorker = await codeFor('launcher-sw.js')
  await workerBreakpoint(origin, launcherWorker, 'self.skipWaiting()', 'src/service-workers/launcher/index.js', 'self.dispatchEvent(new MessageEvent("message",{data:{code:"SKIP_WAITING"}}))')

  // Reuse the same page target on the app origin, before installing its worker.
  const injectedOffset = injected.indexOf('new MessageChannel')
  assert.ok(injectedOffset >= 0)
  const injectedPoint = location(injected, injectedOffset)
  const injectedBreakpoint = await browser.send('Debugger.setBreakpointByUrl', { url: '/~~injected/app-page-loader.txt.js', ...injectedPoint }, browser.sessionId)
  await browser.navigate(appOrigin)
  const injectedScript = await browser.until(() => parsed.find(script => script.url.endsWith('/~~injected/app-page-loader.txt.js')), 'injected map discovery')
  assert.equal(injectedScript.sourceMapURL, urlFor(injected))
  await browser.until(() => pauses.find(event => event.params.hitBreakpoints?.includes(injectedBreakpoint.breakpointId)), 'injected breakpoint')
  assert.equal(new SourceMap(await mapFor(injected)).findEntry(injectedPoint.lineNumber, injectedPoint.columnNumber).originalSource, 'src/scripts/app-page-loader.txt.js')
  await browser.evaluate('navigator.serviceWorker.register("/sw.js").then(()=>navigator.serviceWorker.ready).then(()=>true)', appOrigin)
  const info = await browser.until(async () => (await browser.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url === appOrigin + '/sw.js'), 'app worker')
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
  await browser.send('Runtime.evaluate', { expression: 'clients.claim()', awaitPromise: true }, sessionId)
  await browser.until(() => browser.evaluate('!!navigator.serviceWorker.controller', appOrigin), 'app worker control')
  const before = await browser.evaluate('observedMessages.length', appOrigin)
  await assertMapFetch(appOrigin, injectedScript.sourceMapURL)
  await workerBreakpoint(appOrigin, appWorker, 'console.log("[Service Worker] Install event")', 'src/service-workers/app/index.js', 'self.dispatchEvent(new Event("install"))')
  assert.equal(await browser.evaluate('observedMessages.length', appOrigin), before, 'map reads never enter the app bridge')
  const missing = await browser.evaluate(`fetch('/~~sourcemaps/${'0'.repeat(64)}.map').then(r=>r.status)`, appOrigin)
  assert.equal(missing, 404)
  assert.deepEqual(browserErrors, [])
  console.log('Sourcemaps: launcher, chunk, both workers and injected bridge discovered; original-source breakpoints passed; maps bypass Cache Storage and app bridge.')
} catch (error) {
  await browser?.diagnose('/tmp/44billion-sourcemaps-browser')
  console.error('Parsed scripts:', parsed.filter(script => script.sourceMapURL).map(({ url, sourceMapURL }) => ({ url, sourceMapURL })).slice(-12))
  throw error
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
