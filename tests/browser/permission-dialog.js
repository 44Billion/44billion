import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launchChrome } from './runtime/chrome.js'
import { cssClasses, cssStrings } from '../../src/assets/styles/theme.js'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const reset = await readFile(new URL('../../src/assets/styles/reset.css', import.meta.url), 'utf8')
const globalCss = await readFile(new URL('../../src/assets/styles/global.css', import.meta.url), 'utf8')
const { outputFiles } = await build({
  absWorkingDir: repo,
  stdin: {
    resolveDir: repo,
    contents: `
      import { f } from '#f'
      import { provideAppI18n, setLocalePreference } from '#i18n/index.js'
      import { usePermissionDialogStore } from '#zones/permission-dialog/index.js'
      setLocalePreference('pt-BR')
      provideAppI18n()
      f('permission-fixture', ({ h }) => {
        const permissions = usePermissionDialogStore()
        window.permissionFixture = {
          permissions, outcomes: [], setLocalePreference,
          request(name) {
            permissions.requestPermission({
              app: { id: 'permission-expansion-test', name: 'Permission test' },
              name: 'openApp', eKind: null, remember: false,
              meta: { targetApp: { name } }
            }).then(() => this.outcomes.push('granted'), () => this.outcomes.push('denied'))
          }
        }
        return h\`<permission-dialog />\`
      })
      document.body.insertAdjacentHTML('beforeend', '<permission-fixture></permission-fixture>')
    `
  },
  define: { IS_DEVELOPMENT: 'false', IS_PRODUCTION: 'true' },
  bundle: true, write: false, format: 'esm'
})
const server = createServer((request, response) => {
  const script = request.url === '/app.js'
  response.setHeader('Content-Type', script ? 'text/javascript' : 'text/html')
  response.end(script
    ? outputFiles[0].contents
    : `<!doctype html>
    <html class="${cssClasses.defaultTheme}"><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${reset}${globalCss}${cssStrings.defaultTheme}</style>
      <script type="module" src="/app.js"></script>
    </head><body></body></html>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://localhost:${server.address().port}`
let browser
try {
  browser = await launchChrome()
  await browser.navigate(origin)
  const evaluate = expression => browser.evaluate(expression, origin)
  await browser.until(() => evaluate('Boolean(window.permissionFixture)'), 'permission fixture')
  const session = [...browser.contexts.values()].find(context => context.origin === origin && context.auxData?.isDefault).sessionId
  const input = (method, params) => browser.send(method, params, session)
  await input('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true })
  const longName = 'Aplicativo para conversar, compartilhar arquivos e guardar informações pessoais com segurança. '.repeat(6)
  await evaluate(`permissionFixture.request(${JSON.stringify(longName)}); permissionFixture.request('Second app')`)
  await browser.until(() => evaluate('document.querySelectorAll(".permission-text").length === 2 && Boolean(document.querySelector("dialog[open]"))'), 'queued permission cards')
  const measure = () => evaluate(`(() => {
    const text = document.querySelector('.permission-text');
    return { clamp: Number(getComputedStyle(text).webkitLineClamp), height: text.clientHeight, fullHeight: text.scrollHeight,
      expanded: text.getAttribute('aria-expanded'), overflow: text.scrollWidth > text.clientWidth,
      pending: permissionFixture.permissions.queue$().length, outcomes: [...permissionFixture.outcomes] };
  })()`)
  const initial = await measure()
  assert.equal(initial.clamp, 3)
  assert.equal(initial.expanded, 'false')
  assert.ok(initial.fullHeight > initial.height, 'narrow prompt really truncates the complete permission text')
  assert.equal(initial.overflow, false)
  await evaluate('new Promise(resolve => setTimeout(resolve, 350))')
  const point = await evaluate('(() => { const r = document.querySelector(\'.permission-text\').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 10 }; })()')
  await input('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await input('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await browser.until(async () => (await measure()).clamp === 5, 'pointer reveals two lines')
  assert.ok((await measure()).height > initial.height)
  await evaluate('document.querySelector(".permission-text").focus()')
  for (const [key, code, windowsVirtualKeyCode, clamp] of [['Enter', 'Enter', 13, 7], [' ', 'Space', 32, 9]]) {
    await input('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, text: key === 'Enter' ? '\r' : ' ' })
    await input('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
    await browser.until(async () => (await measure()).clamp === clamp, `${code} reveals two lines`)
  }
  const expanded = await measure()
  assert.equal(expanded.expanded, 'true')
  assert.equal(expanded.pending, 2, 'expansion never resolves a request')
  assert.deepEqual(expanded.outcomes, [])
  assert.equal(await evaluate('getComputedStyle(document.querySelectorAll(".permission-text")[1]).webkitLineClamp'), '3', 'the other request keeps its own initial limit')
  await evaluate("permissionFixture.setLocalePreference('en')")
  await browser.until(() => evaluate('document.querySelector(".permission-text").textContent.startsWith("Can I open")'), 'live translated prompt')
  assert.equal((await measure()).clamp, 9)
  await input('Emulation.setDeviceMetricsOverride', { width: 1024, height: 780, deviceScaleFactor: 1, mobile: false })
  assert.equal((await measure()).clamp, 9, 'resizing preserves the expanded limit')
  await input('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true })
  for (let n = 0; n < 80 && (await measure()).fullHeight > (await measure()).height + 1; n++) {
    const before = (await measure()).clamp
    await evaluate('document.querySelector(".permission-text").click()')
    await browser.until(async () => (await measure()).clamp === before + 2, 'progressive reveal')
  }
  const full = await measure()
  assert.ok(full.fullHeight <= full.height + 1, 'the complete text can be revealed')
  await evaluate('document.querySelector(".permission-text").click()')
  await browser.until(async () => (await measure()).clamp === full.clamp + 2, 'extra activation after complete reveal')
  assert.equal((await measure()).height, full.height, 'extra clicks have no visible effect after complete reveal')
  assert.equal((await measure()).pending, 2)
  assert.deepEqual((await measure()).outcomes, [])
  await evaluate('document.querySelector(".allow-button").click()')
  await browser.until(() => evaluate('permissionFixture.outcomes.length === 1 && document.querySelectorAll(".permission-text").length === 1'), 'grant still resolves only its request')
  assert.deepEqual(await evaluate('permissionFixture.outcomes'), ['granted'])
  assert.equal((await measure()).clamp, 3)
  await evaluate('document.querySelector(".deny-button").click()')
  await browser.until(() => evaluate('permissionFixture.outcomes.length === 2 && !document.querySelector("dialog[open]")'), 'deny still closes the remaining request')
  assert.deepEqual(await evaluate('permissionFixture.outcomes'), ['granted', 'denied'])
  await evaluate("permissionFixture.request('Fresh app')")
  await browser.until(() => evaluate('Boolean(document.querySelector("dialog[open] .permission-text"))'), 'fresh request')
  assert.equal((await measure()).clamp, 3)
  assert.equal((await measure()).expanded, 'false')
  assert.deepEqual(browser.logs.filter(log => log.method === 'Runtime.exceptionThrown'), [])
  console.log('Permission prompts passed: 3/5/7/9 lines, pointer/keyboard, full reveal, locale/resize, independent requests and grant/deny.')
} catch (error) {
  await browser?.diagnose('/tmp/44billion-permission-dialog-failure')
  throw error
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
