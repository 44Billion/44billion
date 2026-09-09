import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { access, realpath } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const launcherRoot = path.resolve(import.meta.dirname, '..')
export const launcherUrl = 'http://localhost:10000'
export const healthPath = '/__dev/health'
export const runtimeProtocol = 2

export async function readRuntimeHealth () {
  try {
    const response = await fetch(launcherUrl + healthPath, { signal: AbortSignal.timeout(1500) })
    return response.ok ? await response.json() : null
  } catch { return null }
}

export async function assertPortAvailable (port) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(error.code === 'EADDRINUSE'
      ? new Error(`Port ${port} is occupied; stop the conflicting server first.`, { cause: error })
      : error))
    server.listen(port, '127.0.0.1', resolve)
  })
  await new Promise(resolve => server.close(resolve))
}

// The returned handle owns only the processes started by this call.
export async function ensureRuntime ({ signal, log = text => process.stdout.write(text), timeoutMs = 90000 } = {}) {
  signal?.throwIfAborted()
  const lifetime = new AbortController()
  const workSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
  const root = await realpath(launcherRoot)
  let existing = await readRuntimeHealth()
  const matches = health => health?.service === '44billion' && health.protocol === runtimeProtocol && health.root === root
  if (matches(existing)) {
    const deadline = Date.now() + timeoutMs
    while (!existing?.ready) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the existing local launcher')
      await delay(100, undefined, { signal: workSignal })
      existing = await readRuntimeHealth()
      if (!matches(existing)) throw new Error('The existing launcher stopped or became incompatible')
    }
    signal?.throwIfAborted()
    return { url: launcherUrl, owned: false, close: async () => {}, closed: new Promise(() => {}) }
  }
  await assertPortAvailable(10000)
  await assertPortAvailable(8080)
  await assertPortAvailable(4000)
  const children = []
  let stopping
  const closed = Promise.withResolvers()
  closed.promise.catch(() => {})
  const close = () => (stopping ??= (async () => {
    lifetime.abort()
    signal?.removeEventListener('abort', onAbort)
    await Promise.all(children.map(async ({ child, exited }) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      try { await exited } finally { clearTimeout(timer) }
    }))
    closed.resolve()
  })())
  const fail = error => { closed.reject(error); close().catch(() => {}) }
  const onAbort = () => fail(signal.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  const start = (args, cwd, onOutput = () => {}, executable = process.execPath) => {
    workSignal.throwIfAborted()
    const child = spawn(executable, args, {
      cwd, env: { ...process.env, NODE_ENV: 'development', EZ_VAULT_DEV: '1', EZ_VAULT_SERVE_DIR: '.dev', PORT: '4000' },
      stdio: executable === process.execPath ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe']
    })
    const exited = new Promise(resolve => child.once('close', resolve))
    children.push({ child, exited })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log(bytes.toString()); onOutput(bytes.toString()) })
    child.once('error', fail)
    child.once('exit', (code, reason) => {
      if (!stopping) fail(new Error(`${path.basename(cwd)}/${args[0]} exited (${reason ?? code})`))
    })
    return child
  }
  const ready = async () => {
    const buildState = { launcherBuilt: false, vaultWatching: false }
    let vaultLog = ''
    const build = start(['bin/build.js'], root)
    build.on('message', message => { if (message.type === 'build-end') buildState.launcherBuilt = message.ok })
    const vaultRoot = path.resolve(root, '../ez-vault')
    start(['bin/build.js', '--watch'], vaultRoot, text => {
      vaultLog = (vaultLog + text).slice(-2000)
      buildState.vaultWatching ||= vaultLog.includes('watching src/')
    })
    while (!buildState.launcherBuilt || !buildState.vaultWatching) await delay(100, undefined, { signal: workSignal })
    for (const file of ['index.html', 'app.js']) {
      while (true) {
        try { await access(path.join(vaultRoot, '.dev', file)); break } catch { await delay(100, undefined, { signal: workSignal }) }
      }
    }
    // Keep the existing development vault origin, including previously stored accounts.
    start(['server.py'], vaultRoot, undefined, 'python3')
    start(['server/dev-server.js'], root)
    while (true) {
      const health = await readRuntimeHealth()
      if (health?.ready && health.root === root && health.protocol === runtimeProtocol) break
      await delay(100, undefined, { signal: workSignal })
    }
  }
  let timeout
  try {
    await Promise.race([
      ready(), closed.promise.then(() => { throw new Error('Runtime stopped before becoming ready') }),
      new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Timed out starting the local launcher')), timeoutMs) })
    ])
    log(`44billion ready: ${launcherUrl}\n`)
    return { url: launcherUrl, owned: true, close, closed: closed.promise }
  } catch (error) {
    await close()
    throw error
  } finally { clearTimeout(timeout) }
}
