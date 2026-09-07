import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const DEV_TARGET_PATTERN = /^(?:[a-z0-9-]+\.)?localhost:(?:10000|4000)$/

export function targetLabelForHost (host) {
  if (!host) return 'unknown'
  if (host.endsWith(':4000') || host === 'vault.localhost:10000') return 'vault'
  const subdomain = host.split('.')[0]
  return /^\d+$/.test(subdomain) ? `app:${subdomain}` : 'launcher'
}

export function shouldShowLevel (type, debugEnabled) {
  return !['debug', 'trace'].includes(type) || debugEnabled === true
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
    const body = entries.join(', ') + (preview.overflow ? ', …' : '')
    return isArray ? `[${body}]` : `{${body}}`
  }
  return remoteObject.description || preview?.description || remoteObject.type || 'undefined'
}

export function socketCandidates (preferred) {
  const sockets = { chrome: 'chrome_devtools_remote', edge: 'edge_devtools_remote' }
  return [...new Set([sockets[preferred], ...Object.values(sockets)].filter(Boolean))]
}

// ADB belongs to this handle; the caller separately owns its development runtime.
export async function startAdbSession ({
  signal, args = process.argv.slice(2), serial = process.env.ANDROID_SERIAL,
  cdpPort = process.env.CDP_PORT || '0', log = console.log,
  _runAdb = args => spawnSync('adb', args, { encoding: 'utf8', timeout: 5000 }),
  _fetch = fetch, _WebSocket = WebSocket
} = {}) {
  signal?.throwIfAborted()
  const browser = args.find(arg => arg.startsWith('--browser='))?.slice('--browser='.length)
  if (browser && !['chrome', 'edge'].includes(browser)) throw new Error('Use --browser=chrome or --browser=edge')
  if (!/^\d+$/.test(String(cdpPort)) || Number(cdpPort) > 65535) throw new Error('CDP_PORT must be between 0 and 65535')
  const debug = args.includes('--debug')
  const controller = new AbortController()
  const owned = new Set()
  const sockets = new Map()
  let forward
  let loop = Promise.resolve()
  let closing
  let announced = false

  function adb (args) {
    const result = _runAdb([...(serial ? ['-s', serial] : []), ...args])
    if (result.error?.code === 'ENOENT') throw new Error('adb was not found in PATH. Install Android platform-tools.')
    if (result.error || result.status !== 0) throw new Error(`adb ${args[0]} failed: ${result.error?.message || result.stderr?.trim() || 'check adb devices and authorize debugging on the device'}`)
    return (result.stdout || '').trim()
  }

  function mappings (type) {
    return adb([type, '--list']).split('\n').filter(Boolean).map(line => {
      const [device, local, remote] = line.trim().split(/\s+/)
      return { device, local, remote }
    })
  }

  function remove (mapping) {
    if (!owned.has(mapping)) return
    try {
      const current = mappings(mapping.type).find(entry => entry.local === mapping.local && (mapping.type === 'reverse' || entry.device === serial))
      if (current?.remote === mapping.remote) adb([mapping.type, '--remove', mapping.local])
    } catch (error) { log(`[adb] Cleanup: ${error.message}`) }
    owned.delete(mapping)
  }

  function reverse (port) {
    const endpoint = `tcp:${port}`
    const existing = () => mappings('reverse').find(entry => entry.local === endpoint)
    const current = existing()
    if (current?.remote === endpoint) return
    if (current) throw new Error(`ADB reverse ${endpoint} already points to ${current.remote}; resolve the conflict first.`)
    try { adb(['reverse', '--no-rebind', endpoint, endpoint]) } catch (error) {
      if (existing()?.remote === endpoint) return
      throw error
    }
    owned.add({ type: 'reverse', local: endpoint, remote: endpoint })
  }

  async function fetchTargets () {
    if (!forward) return null
    try {
      const response = await _fetch(`http://127.0.0.1:${forward.port}/json`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)])
      })
      if (!response.ok) { await response.body?.cancel(); return null }
      const targets = await response.json()
      return Array.isArray(targets) ? targets : null
    } catch { return null }
  }

  async function connectToBrowser () {
    if (forward) { remove(forward); forward = null }
    let preferred = browser
    if (!preferred) {
      const activity = adb(['shell', 'dumpsys', 'activity', 'activities']).toLowerCase()
      preferred = activity.includes('com.microsoft.emmx') ? 'edge' : 'chrome'
    }
    for (const socket of socketCandidates(preferred)) {
      controller.signal.throwIfAborted()
      const remote = `localabstract:${socket}`
      const assigned = adb(['forward', '--no-rebind', `tcp:${cdpPort}`, remote])
      const port = Number(cdpPort) || Number(assigned)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ADB did not return a valid console port')
      forward = { type: 'forward', local: `tcp:${port}`, remote, port }
      owned.add(forward)
      const deadline = Date.now() + 2500
      while (Date.now() < deadline) {
        if (await fetchTargets()) {
          if (!announced) { log(`[adb-console] attached to ${socket}`); announced = true }
          return true
        }
        await delay(250, undefined, { signal: controller.signal })
      }
      remove(forward)
      forward = null
    }
    return false
  }

  function targetHost (target) {
    try { return new URL(target.url).host } catch { return '' }
  }

  function emitLine (target, text) {
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false })
    const line = `${time} [${targetLabelForHost(targetHost(target))}] ${text}`
    const highlight = /\[widget-(?:drag|resize|lifecycle|bridge)\]/.test(text)
    log(highlight && process.stdout.isTTY ? `\x1b[35m${line}\x1b[0m` : line)
  }

  function attach (target) {
    if (!target.webSocketDebuggerUrl || sockets.has(target.id)) return
    const socket = new _WebSocket(target.webSocketDebuggerUrl)
    sockets.set(target.id, socket)
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable' })))
    socket.addEventListener('message', event => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (message.method === 'Runtime.consoleAPICalled' && shouldShowLevel(message.params.type, debug)) {
        emitLine(target, (message.params.args || []).map(value => formatRemoteObject(value)).join(' '))
      } else if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails
        emitLine(target, `! ${details?.exception?.description || details?.text || 'Uncaught exception'}`)
      }
    })
    const forget = () => { if (sockets.get(target.id) === socket) sockets.delete(target.id) }
    socket.addEventListener('close', forget)
    socket.addEventListener('error', () => { forget(); socket.close() })
  }

  async function streamConsole () {
    let warned = false
    while (!controller.signal.aborted) {
      try {
        let targets = await fetchTargets()
        if (!targets && await connectToBrowser()) targets = await fetchTargets()
        if (!targets) throw new Error('Open Chrome/Edge on the device at http://localhost:10000')
        warned = false
        for (const target of targets) {
          if (['page', 'iframe'].includes(target.type) && DEV_TARGET_PATTERN.test(targetHost(target))) attach(target)
        }
        for (const [id, socket] of sockets) {
          if (!targets.some(target => target.id === id)) { sockets.delete(id); socket.close() }
        }
      } catch (error) {
        if (controller.signal.aborted) return
        if (!warned) log(`[adb-console] Waiting: ${error.message}`)
        warned = true
      }
      await delay(1500, undefined, { signal: controller.signal }).catch(() => {})
    }
  }

  const onAbort = () => { close().catch(error => log(`[adb] ${error.message}`)) }
  const close = () => (closing ??= (async () => {
    signal?.removeEventListener('abort', onAbort)
    controller.abort()
    await loop
    for (const socket of sockets.values()) { try { socket.close() } catch {} }
    sockets.clear()
    for (const mapping of [...owned].reverse()) remove(mapping)
  })())
  try {
    if (adb(['get-state']) !== 'device') throw new Error('Authorize an Android device first; check adb devices.')
    serial = adb(['get-serialno'])
    if (!serial || serial === 'unknown') throw new Error('No Android device selected; set ANDROID_SERIAL when multiple devices are connected.')
    reverse(10000)
    reverse(4000)
    signal?.throwIfAborted()
    signal?.addEventListener('abort', onAbort, { once: true })
    log('[adb] Phone localhost:10000 and localhost:4000 now reach this computer. Open the local launcher URL on the phone.')
    loop = streamConsole()
    return { serial, close }
  } catch (error) { await close(); throw error }
}
