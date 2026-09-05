// Dev helper: exposes the local dev servers — launcher (:10000) and EZ Vault
// (:4000) — to an Android device connected over USB via `adb reverse`, then
// runs `npm start`. It also streams the phone browser's DevTools console to
// this terminal through the Chrome DevTools Protocol, so widget/app logs show
// up here without needing a desktop browser.
//
// Optionally connect over wifi:
// https://developer.android.com/tools/adb?hl=pt-br#connect-to-a-device-over-wi-fi
// Go to Dev Options > Wi-Fi debugging > Pair device with pairing code.
// Then run `adb pair <ip>:<port>`,
// `adb connect <ip>:<port>` and
// `adb devices` to verify the connection.
//
// Usage:
//   npm run start:adb             # all console levels except debug/trace
//   npm run start:adb -- --debug  # also show debug/trace (app noise is there)
//   npm run start:adb -- --browser=edge # prefer Edge's debugging socket
//
// On the phone, open http://localhost:10000. Chrome/Edge resolve `*.localhost`
// to loopback, so app subdomains (`0.localhost:10000`, ...) reach this machine
// with no tunnel and no TLS (localhost is a secure context, so service
// workers keep working). Lines containing `[widget-drag]`,
// `[widget-resize]` or `[widget-lifecycle]` are highlighted. App ports use
// `adb reverse` (phone -> this machine); the browser's DevTools socket uses
// `adb forward` (this machine -> phone). Both are removed on exit.

import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const LAUNCHER_PORT = process.env.LAUNCHER_PORT || '10000'
const VAULT_PORT = process.env.VAULT_PORT || '4000'
const CDP_PORT = process.env.CDP_PORT || '9222'
const CDP_POLL_MS = 1500
const CDP_CONNECT_GRACE_MS = 2500
const DEV_TARGET_PATTERN = /^(?:[a-z0-9-]+\.)?localhost:(?:10000|4000)$/
const MAGENTA = '\x1b[35m'
const RESET = '\x1b[0m'

const args = process.argv.slice(2)
const showDebug = args.includes('--debug')
let browserOverride = null
if (args.includes('--browser=edge')) browserOverride = 'edge'
else if (args.includes('--browser=chrome')) browserOverride = 'chrome'

const cdpSockets = new Map()
let npm
let shuttingDown = false
let browserAnnounced = false

// ---- pure helpers (unit-tested) ----

export function targetLabelForHost (host) {
  if (!host) return 'unknown'
  if (host.endsWith(':4000')) return 'vault'
  const subdomain = host.split('.')[0]
  return /^\d+$/.test(subdomain) ? `app:${subdomain}` : 'launcher'
}

export function shouldShowLevel (type, debugEnabled) {
  if (type === 'debug' || type === 'trace') return debugEnabled === true
  return true
}

export function formatRemoteObject (remoteObject, depth = 0) {
  if (!remoteObject || typeof remoteObject !== 'object') return String(remoteObject)
  if (Object.hasOwn(remoteObject, 'value')) return String(remoteObject.value)
  const preview = remoteObject.preview
  if (preview && Array.isArray(preview.properties)) {
    if (depth > 2) return preview.description || '…'
    const isArray = remoteObject.subtype === 'array' || preview.subtype === 'array'
    const entries = preview.properties.map(property => {
      const value = formatRemoteObject(property, depth + 1)
      const rendered = property.type === 'string' ? `"${value}"` : value
      return isArray ? rendered : `${property.name}: ${rendered}`
    })
    const overflow = preview.overflow ? ', …' : ''
    const body = entries.join(', ') + overflow
    return isArray ? `[${body}]` : `{${body}}`
  }
  if (remoteObject.description) return remoteObject.description
  if (preview?.description) return preview.description
  return remoteObject.type || 'undefined'
}

// ---- adb / process management ----

function adb (adbArgs) {
  const result = spawnSync('adb', adbArgs, { encoding: 'utf8' })
  if (result.error?.code === 'ENOENT') {
    throw new Error('adb was not found in PATH. Install Android platform-tools and enable USB debugging on the device.')
  }
  return result
}

function removeReverse (port) {
  const result = adb(['reverse', '--remove', `tcp:${port}`])
  if (result.status !== 0) console.error(`Failed to remove adb reverse for port ${port}`)
}

function removeForward (port) {
  const result = adb(['forward', '--remove', `tcp:${port}`])
  if (result.status !== 0) console.error(`Failed to remove adb forward for port ${port}`)
}

function cleanup (code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const socket of cdpSockets.values()) {
    try { socket.close() } catch { /* already closed */ }
  }
  if (npm?.pid) {
    try { process.kill(-npm.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  removeReverse(LAUNCHER_PORT)
  removeReverse(VAULT_PORT)
  removeForward(CDP_PORT)
  process.exit(code)
}

function checkDevice () {
  const state = adb(['get-state'])
  if (state.status !== 0 || (state.stdout || '').trim() !== 'device') {
    console.error('No Android device with USB debugging connected. Check `adb devices` first.')
    process.exit(1)
  }
}

function setupReverse (port) {
  const result = adb(['reverse', `tcp:${port}`, `tcp:${port}`])
  if (result.status !== 0) {
    console.error(`adb reverse failed for port ${port}: ${(result.stderr || '').trim()}`)
    removeReverse(LAUNCHER_PORT)
    removeReverse(VAULT_PORT)
    removeForward(CDP_PORT)
    process.exit(1)
  }
}

// ---- Chrome DevTools Protocol console streaming ----

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function detectForegroundBrowser () {
  const result = adb(['shell', 'dumpsys activity activities'])
  const output = (result.stdout || '').toLowerCase()
  if (output.includes('com.microsoft.emmx')) return 'edge'
  if (output.includes('com.android.chrome')) return 'chrome'
  return null
}

function socketCandidates () {
  const order = browserOverride
    ? [browserOverride]
    : [detectForegroundBrowser()].filter(Boolean)
  for (const name of ['chrome_devtools_remote', 'edge_devtools_remote']) {
    if (!order.includes(name)) order.push(name)
  }
  return order
}

async function fetchTargets () {
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function connectToBrowser () {
  adb(['forward', '--remove', `tcp:${CDP_PORT}`])
  for (const socketName of socketCandidates()) {
    const result = adb(['forward', `tcp:${CDP_PORT}`, `localabstract:${socketName}`])
    if (result.status !== 0) continue
    const deadline = Date.now() + CDP_CONNECT_GRACE_MS
    while (Date.now() < deadline) {
      if (await fetchTargets()) {
        if (!browserAnnounced) {
          browserAnnounced = true
          console.log(`[adb-console] attached to ${socketName}`)
        }
        return true
      }
      await sleep(250)
    }
  }
  return false
}

function targetHost (target) {
  try { return new URL(target.url).host } catch { return '' }
}

function isDevTarget (target) {
  if (target.type !== 'page' && target.type !== 'iframe') return false
  return DEV_TARGET_PATTERN.test(targetHost(target))
}

function emitLine (target, text, highlight) {
  const time = new Date().toLocaleTimeString('pt-BR', { hour12: false })
  const line = `${time} [${targetLabelForHost(targetHost(target))}] ${text}`
  if (highlight && process.stdout.isTTY) console.log(`${MAGENTA}${line}${RESET}`)
  else console.log(line)
}

function printConsole (target, { type, args = [] }) {
  if (!shouldShowLevel(type, showDebug)) return
  const text = args.map(formatRemoteObject).join(' ')
  const highlight =
    text.includes('[widget-drag]') ||
    text.includes('[widget-resize]') ||
    text.includes('[widget-lifecycle]') ||
    text.includes('[widget-bridge]')
  emitLine(target, text, highlight)
}

function printException (target, { exceptionDetails }) {
  const text = exceptionDetails?.exception?.description ||
    exceptionDetails?.text ||
    'Uncaught exception'
  emitLine(target, `! ${text}`, false)
}

function attachTarget (target) {
  if (!target.webSocketDebuggerUrl || cdpSockets.has(target.id)) return
  let socket
  try {
    socket = new WebSocket(target.webSocketDebuggerUrl)
  } catch {
    return
  }
  cdpSockets.set(target.id, socket)
  let nextId = 0
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ id: ++nextId, method: 'Runtime.enable' }))
  })
  socket.addEventListener('message', event => {
    let message
    try { message = JSON.parse(event.data) } catch { return }
    if (message.method === 'Runtime.consoleAPICalled') printConsole(target, message.params)
    else if (message.method === 'Runtime.exceptionThrown') printException(target, message.params)
  })
  socket.addEventListener('close', () => cdpSockets.delete(target.id))
  socket.addEventListener('error', () => {
    cdpSockets.delete(target.id)
    try { socket.close() } catch { /* already closed */ }
  })
}

async function cdpLoop () {
  let warned = false
  while (true) {
    if (shuttingDown) break
    let targets = await fetchTargets()
    if (!targets && await connectToBrowser()) targets = await fetchTargets()
    if (!targets) {
      if (!warned) {
        console.log('[adb-console] waiting for Chrome/Edge on the device; open http://localhost:10000 in the browser…')
        warned = true
      }
      await sleep(CDP_POLL_MS)
      continue
    }
    warned = false
    for (const target of targets) {
      if (isDevTarget(target)) attachTarget(target)
    }
    for (const [id, socket] of cdpSockets) {
      if (!targets.some(target => target.id === id)) {
        cdpSockets.delete(id)
        try { socket.close() } catch { /* already closed */ }
      }
    }
    await sleep(CDP_POLL_MS)
  }
}

function main () {
  process.on('SIGINT', () => cleanup(130))
  process.on('SIGTERM', () => cleanup(143))

  try {
    checkDevice()
  } catch (err) {
    console.error(err?.message ?? err)
    process.exit(1)
  }

  setupReverse(LAUNCHER_PORT)
  setupReverse(VAULT_PORT)

  console.log(`adb reverse ready: phone localhost:${LAUNCHER_PORT} -> this machine`)
  console.log(`Launcher: http://localhost:${LAUNCHER_PORT}`)

  cdpLoop().catch(err => console.error(`[adb-console] failed: ${err?.message ?? err}`))

  npm = spawn('npm', ['start'], {
    detached: true,
    stdio: 'inherit'
  })

  npm.once('error', err => {
    console.error(`Failed to start npm: ${err?.message ?? err}`)
    cleanup(1)
  })
  npm.once('exit', (code, signal) => {
    cleanup(code ?? (signal ? 1 : 0))
  })
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
