import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { launchChrome } from './runtime/chrome.js'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const { outputFiles } = await build({
  absWorkingDir: repo,
  stdin: {
    resolveDir: repo,
    contents: `
      import { f, useStore, useCallback } from '#f'
      import '#shared/menu.js'
      f('focus-fixture', ({ h }) => {
        const state = useStore({
          isOpen$: false, app$: '', anchorRef$: null,
          close () { this.isOpen$(false) },
          open (app, anchor) {
            this.close()
            queueMicrotask(() => {
              this.app$(app)
              this.anchorRef$(anchor)
              this.isOpen$(true)
            })
          }
        })
        const render = useCallback(function () {
          return this.h\`<div>Open \${state.app$()}</div><button>Switch User</button>\`
        })
        return h\`
          <div id='first' onclick=\${event => state.open('first', event.currentTarget)}>First</div>
          <div id='second' onclick=\${event => state.open('second', event.currentTarget)}>Second</div>
          <a-menu props=\${{ ...state, render, style: '& { position: fixed; left: 150px; top: 100px; }' }} />
        \`
      })
      document.body.insertAdjacentHTML('beforeend', '<focus-fixture></focus-fixture>')
    `
  },
  bundle: true,
  write: false,
  format: 'esm'
})
const server = createServer((request, response) => {
  const script = request.url === '/app.js'
  response.setHeader('Content-Type', script ? 'text/javascript' : 'text/html')
  response.end(script
    ? outputFiles[0].contents
    : `<!doctype html>
    <style>#first, #second { width: 80px; height: 40px; }</style>
    <script type="module" src="/app.js"></script>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://localhost:${server.address().port}`
let chrome
let timer
let sessionId
try {
  chrome = await launchChrome()
  timer = setTimeout(() => { console.error('Menu focus check timed out'); chrome.close().catch(error => console.error(error)) }, 30000)
  await chrome.navigate(origin)
  const evaluate = expression => chrome.evaluate(expression, origin)
  await chrome.until(() => evaluate('!!document.querySelector("#first")'), 'menu fixture', 5000)
  sessionId = [...chrome.contexts.values()].find(context => context.origin === origin && context.auxData?.isDefault).sessionId
  const input = (method, params) => chrome.send(method, params, sessionId)
  for (const id of ['first', 'second', 'first']) {
    const point = await evaluate(`(() => {
      const rect = document.getElementById('${id}').getBoundingClientRect()
      return { x: rect.x + 10, y: rect.y + 10 }
    })()`)
    await input('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await input('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await chrome.until(() => evaluate(`document.querySelector('dialog:popover-open')?.textContent.includes('Open ${id}')`), `menu ${id}`, 5000)
    await delay(350)
    assert.equal(await evaluate('document.activeElement === document.querySelector("dialog")'), true, `${id}: initial focus stays on the menu`)
    assert.equal(await evaluate('!!document.querySelector("dialog button:focus-visible")'), false, `${id}: no action highlighted after mouse opening`)
  }
  await input('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await input('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  assert.equal(await evaluate('document.activeElement === document.querySelector("dialog button") && document.activeElement.matches(":focus-visible")'), true, 'Tab retains visible keyboard focus on the action')
  console.log('Chrome menu focus passed: opening, switching apps, reopening and keyboard focus')
} catch (error) {
  if (chrome && sessionId) {
    console.error(JSON.stringify(chrome.logs))
    try {
      const { data } = await chrome.send('Page.captureScreenshot', { format: 'png' }, sessionId)
      await writeFile('/tmp/44billion-menu-focus-failure.png', Buffer.from(data, 'base64'))
    } catch {}
  }
  throw error
} finally {
  clearTimeout(timer)
  await chrome?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
