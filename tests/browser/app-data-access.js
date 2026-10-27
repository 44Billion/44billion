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
const appIcon = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2246%22 height=%2246%22%3E%3Crect width=%2246%22 height=%2246%22 rx=%2210%22 fill=%22%23888%22/%3E%3C/svg%3E'
const { outputFiles } = await build({
  absWorkingDir: repo,
  stdin: {
    resolveDir: repo,
    contents: `
      import { f, useLocation } from '#f'
      import { provideAppI18n, setLocalePreference } from '#i18n/index.js'
      import router from './src/components/zones/multi-napp/router.js'
      import {
        createOrUpdatePermission,
        listAllPermissions
      } from '#services/idb/browser/queries/permission.js'
      import '#views/app-data-access/index.js'
      import '#zones/confirmation-dialog/index.js'

      setLocalePreference('en')
      provideAppI18n()
      const icon = ${JSON.stringify({ url: appIcon })}
      for (const [appId, name] of [['app-z', 'Zulu'], ['app-a', 'Alpha']]) {
        localStorage.setItem('session_appById_' + appId + '_name', JSON.stringify(name))
        localStorage.setItem('session_appById_' + appId + '_icon', JSON.stringify(icon))
      }
      await Promise.all([
        createOrUpdatePermission('app-z', 'eventAccess', 1, ''),
        createOrUpdatePermission('app-a', 'eventAccess', 0, ''),
        createOrUpdatePermission('app-a', 'eventAccessPersonal', 9, 'zillion:conversation-summaries:v1'),
        createOrUpdatePermission('app-a', 'legacyCryptoAccess', -1, '')
      ])

      window.fixture = {
        token: crypto.randomUUID(),
        permissions: () => listAllPermissions()
      }
      f('app-data-access-fixture', ({ h }) => {
        useLocation(router)
        return h\`
          <app-data-access />
          <confirmation-dialog />
        \`
      })
      document.body.insertAdjacentHTML('beforeend', '<app-data-access-fixture></app-data-access-fixture>')
    `
  },
  define: { IS_DEVELOPMENT: 'false', IS_PRODUCTION: 'true' },
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
  const context = await browser.until(() =>
    [...browser.contexts.values()].find(context => context.origin === origin && context.auxData?.isDefault),
  'permission page context')
  await browser.until(() => evaluate('Boolean(window.fixture)'), 'permission fixture')
  await browser.until(() => evaluate('document.querySelectorAll("app-data-access-card").length === 2'), 'permission apps')

  assert.deepEqual(await evaluate('[...document.querySelectorAll(".app-name")].map(node => node.textContent)'), ['Alpha', 'Zulu'])
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".summary > span")].map(node => node.textContent)'), [
    'Apps with access 2',
    'Permissions 4'
  ])
  assert.deepEqual(await evaluate(`(() => {
    const header = document.querySelector('app-data-access .header')
    const summary = document.querySelector('.summary').getBoundingClientRect()
    const card = document.querySelector('app-data-access-card .app-card').getBoundingClientRect()
    return {
      headerHeight: header.getBoundingClientRect().height,
      headerBorder: getComputedStyle(header).borderBottomWidth,
      hasIntro: Boolean(document.querySelector('app-data-access .intro')),
      summaryToCard: Math.round(card.top - summary.bottom)
    }
  })()`), {
    headerHeight: 55,
    headerBorder: '0px',
    hasIntro: false,
    summaryToCard: 16
  })

  await evaluate('document.querySelector(".app-toggle").click()')
  await browser.until(() => evaluate('document.querySelectorAll(".permission-row").length === 3'), 'Alpha permissions')
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".permission-group-title")].map(node => node.textContent)'), [
    'Event data',
    'Personal copies',
    'Encryption'
  ])
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".permission-title")].map(node => node.textContent)'), [
    'profiles',
    'chat messages',
    'Encrypt or decrypt any data'
  ])
  assert.equal(await evaluate('document.querySelectorAll(".broad-badge").length'), 1)
  assert.equal(await evaluate('document.body.textContent.includes("zillion:conversation-summaries:v1")'), false)
  assert.deepEqual(await evaluate(`(() => {
    const card = document.querySelector('app-data-access-card .app-card').getBoundingClientRect()
    const group = document.querySelector('.permission-group').getBoundingClientRect()
    const content = document.querySelector('.permission-group-title').getBoundingClientRect()
    const revoke = getComputedStyle(document.querySelector('.revoke-button'))
    const revokeAll = getComputedStyle(document.querySelector('.revoke-all'))
    return {
      borderTop: getComputedStyle(document.querySelector('.permission-group')).borderTopWidth,
      groupSeparators: [...document.querySelectorAll('.permission-group')]
        .map(group => getComputedStyle(group).borderTopWidth),
      groupSpansCard: Math.round(group.left) === Math.round(card.left) && Math.round(group.right) === Math.round(card.right),
      contentInset: Math.round(content.left - card.left),
      revokePadding: revoke.padding,
      revokeRadius: revoke.borderRadius,
      revokeFontSize: revoke.fontSize,
      revokeAllPadding: revokeAll.padding,
      revokeAllRadius: revokeAll.borderRadius,
      revokeAllFontWeight: revokeAll.fontWeight,
      distinctBackgrounds: revoke.backgroundColor !== revokeAll.backgroundColor
    }
  })()`), {
    borderTop: '1px',
    groupSeparators: ['1px', '0px', '0px'],
    groupSpansCard: true,
    contentInset: 14,
    revokePadding: '8px 16px',
    revokeRadius: '6px',
    revokeFontSize: '14px',
    revokeAllPadding: '8px 16px',
    revokeAllRadius: '6px',
    revokeAllFontWeight: '600',
    distinctBackgrounds: true
  })

  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.permission-row')]
      .find(node => node.querySelector('.permission-title').textContent === 'chat messages')
    row.querySelector('.revoke-button').click()
  })()`)
  await browser.until(async () => await evaluate('fixture.permissions().then(rows => rows.length === 3)'), 'individual revoke')
  await browser.until(() => evaluate('document.querySelectorAll(".permission-row").length === 2'), 'individual row removed')
  assert.equal(await evaluate('Boolean(document.querySelector("dialog[open]"))'), false)

  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 700,
    deviceScaleFactor: 1,
    mobile: true
  }, context.sessionId)
  await browser.until(() => evaluate('document.documentElement.scrollWidth <= innerWidth'), 'narrow layout')
  assert.equal(await evaluate('document.querySelector(".app-toggle").getBoundingClientRect().width <= innerWidth'), true)
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const mobileAlignment = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.permission-row')]
    const buttons = rows.map(row => row.querySelector('.revoke-button').getBoundingClientRect())
    const copies = rows.map(row => row.querySelector('.permission-copy').getBoundingClientRect())
    return {
      verticalColumn: new Set(buttons.map(button => Math.round(button.left))).size === 1,
      topAligned: buttons.every((button, index) => Math.abs(button.top - copies[index].top) <= 1)
    }
  })()`)
  assert.deepEqual(mobileAlignment, {
    verticalColumn: true,
    topAligned: true
  })

  const token = await evaluate('fixture.token')
  await evaluate('document.querySelector(".revoke-all").click()')
  await browser.until(() => evaluate(`Boolean(
    document.querySelector("dialog[open] .confirm-button") &&
    document.querySelector("#confirmation-dialog-card .message")?.textContent.includes("remain open")
  )`), 'revoke-all confirmation')
  assert.match(await evaluate('document.querySelector("#confirmation-dialog-card .message").textContent'), /remain open/)
  await evaluate('document.querySelector(".confirm-button").click()')
  await browser.until(async () => await evaluate('fixture.permissions().then(rows => rows.length === 1)'), 'Alpha permissions removed')
  await browser.until(() => evaluate('document.querySelectorAll("app-data-access-card").length === 1'), 'Alpha card removed')
  assert.equal(await evaluate('document.querySelector(".app-name").textContent'), 'Zulu')
  assert.equal(await evaluate('fixture.token'), token)

  await evaluate('document.querySelector(".app-toggle").click()')
  await browser.until(() => evaluate('Boolean(document.querySelector(".revoke-all"))'), 'Zulu permission details')
  await evaluate('document.querySelector(".revoke-all").click()')
  await browser.until(() => evaluate(`Boolean(
    document.querySelector("dialog[open] .confirm-button") &&
    document.querySelector("#confirmation-dialog-card .message")?.textContent.includes("remain open")
  )`), 'second confirmation')
  await evaluate('document.querySelector(".confirm-button").click()')
  await browser.until(() => evaluate('document.querySelector(".state-card")?.textContent.includes("No apps have access")'), 'empty permissions state')
  assert.deepEqual(await evaluate('fixture.permissions()'), [])
  assert.equal(await evaluate('fixture.token'), token)
  assert.equal(await evaluate('Boolean(document.querySelector("z-toast"))'), false)
  assert.deepEqual(browser.logs.filter(log => log.method === 'Runtime.exceptionThrown'), [])

  console.log('App Data Access: alphabetical apps, grouped grants, safe scopes, individual and bulk revocation passed.')
} catch (error) {
  await browser?.diagnose('/tmp/44billion-app-data-access-failure')
  throw error
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
