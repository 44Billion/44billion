// Production view/router and IndexedDB, isolated origin and disposable Chrome profile.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { launchChrome } from './runtime/chrome.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, format: 'esm', platform: 'browser',
  splitting: true, outdir: '/tmp/storage-ui-bundle',
  define: { IS_DEVELOPMENT: 'false', IS_PRODUCTION: 'true' },
  stdin: {
    resolveDir: root, contents: `
    import { f, useLocation } from 'thenameisf';
    import 'thenameisf/components/f-route.js';
    import router from './src/components/zones/multi-napp/router.js';
    import { useInitI18n } from './src/i18n/index.js';
    import { cssStrings, cssClasses } from './src/assets/styles/theme.js';
    import { getNostrDb } from './src/services/idb/nostrdb/index.js';
    import * as quotas from './src/services/idb/nostrdb/quotas.js';
    import { finalizeEvent } from 'libp2r2p/event';
    import { getPublicKey } from 'libp2r2p/key';
    globalThis.fixture = { ...quotas };
    const style = document.createElement('style'); style.textContent = cssStrings.defaultTheme;
    document.head.append(style); document.documentElement.classList.add(cssClasses.defaultTheme);
    f('storage-fixture', ({h}) => {
      const location = useLocation(router); useInitI18n(); fixture.location = location;
      return h\`<f-route props=\${{path:'/event-storage'}} /><f-route props=\${{path:'/settings'}} />\`;
    });
    document.body.insertAdjacentHTML('beforeend', '<storage-fixture></storage-fixture>');
    fixture.seed = async () => {
      const secret = new Uint8Array(32).fill(21);
      const foreign = new Uint8Array(32).fill(22);
      const db = getNostrDb(getPublicKey(secret), {maintenance: false});
      await db.add(finalizeEvent({kind:1, created_at:123,tags:[],content:'x'.repeat(6000)}, secret));
      await db.add(finalizeEvent({kind:1, created_at:124,tags:[],content:'cache'}, foreign));
      return quotas.getNostrDbQuotaUsage();
    };
  `
  }
})
const reset = await readFile(new URL('../../src/assets/styles/reset.css', import.meta.url), 'utf8')
const origin = 'http://localhost:10000'
const scripts = new Map(bundle.outputFiles.map(file => ['/' + file.path.split('/').pop(), file.text]))
const browser = await launchChrome({
  intercept: request => scripts.has(new URL(request.url).pathname)
    ? {
        responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }],
        body: Buffer.from(scripts.get(new URL(request.url).pathname)).toString('base64')
      }
    : request.url.startsWith(origin + '/')
      ? {
          responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
          body: Buffer.from(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${reset}:root{color-scheme:light dark}body{height:100vh}storage-fixture{display:flex!important;height:100%}</style></head><body><script type="module" src="/${bundle.outputFiles[0].path.split('/').pop()}"></script></body></html>`).toString('base64')
        }
      : null
})
let context
async function evaluate (expression, ctx = context) {
  const reply = await browser.send('Runtime.evaluate', { expression, contextId: ctx.id, awaitPromise: true, returnByValue: true }, ctx.sessionId)
  if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails))
  return reply.result.value
}
const input = async (key, value) => evaluate(`{const el=document.getElementById('${key}-input');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));}`)
const click = async text => {
  await browser.until(() => evaluate(`[...document.querySelectorAll('event-storage button')].some(el=>el.textContent==='${text}' && !el.disabled)`), `enabled ${text}`)
  return evaluate(`[...document.querySelectorAll('event-storage button')].find(el=>el.textContent==='${text}').click()`)
}
const ready = async () => {
  context = await browser.until(() => [...browser.contexts.values()].find(c => c.origin === origin && c.auxData?.isDefault), 'storage page context')
  await browser.until(() => evaluate('!!document.querySelector("event-storage input") && !document.body.innerText.includes("Calculating…")'), 'storage usage')
}
try {
  await browser.navigate(origin + '/event-storage')
  await ready()
  assert.match(await evaluate('document.body.innerText'), /No events stored/)
  assert.equal(await evaluate('document.querySelectorAll("event-storage svg circle").length'), 4)
  await input('cacheBytes', '64')
  assert.match(await evaluate('document.getElementById("cacheBytes-hint").textContent'), /25,000/)
  assert.equal((await evaluate('fixture.getNostrDbQuotaLimits()')).cacheBytes, 134217728)
  await click('Save limits')
  await browser.until(() => evaluate('document.body.innerText.includes("Limits saved.")'), 'saved limits')
  assert.equal((await evaluate('fixture.getNostrDbQuotaLimits()')).cacheCount, 25000)
  await input('publicBytes', 'bad')
  assert.equal(await evaluate('document.querySelector("event-storage .actions .primary").disabled'), true)
  await click('Discard changes')
  await click('Restore defaults')
  assert.equal(await evaluate('document.getElementById("cacheBytes-input").value'), '128')
  assert.equal((await evaluate('fixture.getNostrDbQuotaLimits()')).cacheCount, 25000)
  await click('Discard changes')
  const usage = await evaluate('fixture.seed()')
  await evaluate('window.dispatchEvent(new Event("focus"))')
  await browser.until(() => evaluate('!document.body.innerText.includes("No events stored")'), 'seeded usage')
  const arcs = await evaluate('[...document.querySelectorAll("event-storage circle[stroke-dasharray]")].map(el=>Number(el.getAttribute("stroke-dasharray").split(" ")[0]))')
  assert.ok(Math.abs(arcs.reduce((a, b) => a + b, 0) - 100) < 0.000001)
  assert.ok(Math.abs(arcs[1] - usage.cacheBytes / (usage.publicBytes + usage.privateBytes) * 100) < 0.000001)

  // Actual same-origin storage event from another tab preserves a dirty field.
  await input('publicBytes', '123')
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const other = await browser.until(() => [...browser.contexts.values()].find(c => c.auxData?.frameId === targetId && c.auxData?.isDefault), 'second tab')
  await browser.send('Page.navigate', { url: origin + '/event-storage' }, other.sessionId)
  const second = await browser.until(() => [...browser.contexts.values()].find(c => c.sessionId === other.sessionId && c.origin === origin && c.auxData?.isDefault), 'second storage context')
  await browser.until(() => evaluate('!!globalThis.fixture', second), 'second fixture')
  await evaluate('fixture.setNostrDbQuotaLimits({publicBytes: 400*1048576, privateBytes: 500*1048576})', second)
  await browser.send('Page.bringToFront', {}, context.sessionId)
  await browser.until(() => evaluate('document.getElementById("privateBytes-input").value === "500"'), 'external limits')
  assert.equal(await evaluate('document.getElementById("publicBytes-input").value'), '123')
  await browser.until(() => evaluate('document.body.innerText.includes("another window")'), 'external change notice')
  await click('Discard changes')
  await input('publicBytes', '0')
  await click('Save limits')
  await browser.until(() => evaluate('document.body.innerText.includes("Above limit")'), 'exceeded quota')
  assert.equal((await evaluate('fixture.getNostrDbQuotaUsage()')).publicBytes, usage.publicBytes)
  assert.equal(await evaluate('document.querySelector("event-storage .track").getAttribute("aria-valuenow")'), '100')

  // Failure and retry without overwriting drafts.
  await evaluate('fixture.originalLocks = navigator.locks.request.bind(navigator.locks); navigator.locks.request = () => Promise.reject(new Error("fixture unavailable"));window.dispatchEvent(new Event("focus"))')
  await browser.until(() => evaluate('document.body.innerText.includes("Unable to read storage usage.")'), 'usage error')
  await evaluate('navigator.locks.request = fixture.originalLocks')
  await click('Try again')
  await browser.until(() => evaluate('!document.body.innerText.includes("Unable to read storage usage.")'), 'usage retry')

  for (const width of [1000, 390]) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 }, context.sessionId)
    for (const theme of ['light', 'dark']) {
      await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, context.sessionId)
      assert.equal(await evaluate('document.querySelector("event-storage").scrollWidth <= innerWidth'), true)
      assert.equal(await evaluate('getComputedStyle(document.querySelector("event-storage .summary")).flexDirection'), width < 500 ? 'column' : 'row')
      await writeFile(`/tmp/44billion-event-storage-${width}-${theme}.png`, Buffer.from((await browser.send('Page.captureScreenshot', { format: 'png' }, context.sessionId)).data, 'base64'))
    }
  }
  await evaluate('document.getElementById("cacheBytes-input").focus()')
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, context.sessionId)
  assert.equal(await evaluate('document.activeElement.id'), 'privateBytes-input')
  await evaluate('fixture.location.pushState({}, "", "/settings")')
  await browser.until(() => evaluate('!!document.querySelector("a-settings")'), 'settings route')
  await evaluate('[...document.querySelectorAll("a-settings button")].find(el=>el.textContent.includes("Event storage")).click()')
  await browser.until(() => evaluate('location.pathname === "/event-storage" && !!document.querySelector("event-storage input")'), 'settings navigation')
  await evaluate('fixture.location.back()')
  await browser.until(() => evaluate('location.pathname === "/settings"'), 'back')
  await evaluate('fixture.location.forward()')
  await browser.until(() => evaluate('location.pathname === "/event-storage"'), 'forward')
  const oldId = context.uniqueId
  await browser.send('Page.reload', {}, context.sessionId)
  await browser.until(() => [...browser.contexts.values()].some(c => c.sessionId === context.sessionId && c.origin === origin && c.uniqueId !== oldId), 'reload context')
  context = [...browser.contexts.values()].find(c => c.sessionId === context.sessionId && c.origin === origin && c.uniqueId !== oldId)
  await browser.until(() => evaluate('!!document.getElementById("publicBytes-input")'), 'direct reload')
  assert.equal(await evaluate('document.getElementById("publicBytes-input").value'), '0')
  console.log('Event storage: drafts, proportional quota, errors, cross-tab updates, themes, responsive layout and routing passed')
} finally {
  await browser.diagnose('/tmp/44billion-event-storage-browser')
  await browser.close()
}
