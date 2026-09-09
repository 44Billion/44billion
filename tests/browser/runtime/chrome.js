import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import os from 'node:os'

// A deny-by-default proxy also blocks WebSocket/CONNECT traffic from workers.
async function localProxy () {
  const server = createServer((req, res) => {
    let url
    try { url = new URL(req.url) } catch { res.writeHead(400).end(); return }
    if (url.protocol !== 'http:' || !/^(?:[a-z0-9-]+\.)*localhost$/.test(url.hostname)) { res.writeHead(403).end(); return }
    const upstream = request({ hostname: '127.0.0.1', port: url.port || 80, path: url.pathname + url.search, method: req.method, headers: req.headers, agent: false }, reply => {
      res.writeHead(reply.statusCode, reply.headers)
      reply.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  server.on('connect', (_, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'))
  server.on('upgrade', (_, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

export async function launchChrome ({ externalNetwork = false, intercept = () => null } = {}) {
  const profile = await mkdtemp(path.join(os.tmpdir(), '44billion-chrome-'))
  const proxy = externalNetwork ? null : await localProxy()
  const args = ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', '--window-size=1280,900', `--user-data-dir=${profile}`]
  if (proxy) args.push(`--proxy-server=http://127.0.0.1:${proxy.port}`, '--proxy-bypass-list=<-loopback>')
  const child = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', [...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const contexts = new Map()
  const frames = new Map()
  const sessions = new Map()
  const logs = []
  const exceptions = []
  let stderr = ''
  let buffer = ''
  let sequence = 0
  let stopped = false
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8000) })
  const fail = error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error) } pending.clear() }
  child.once('error', fail)
  child.once('exit', code => fail(new Error(`Chrome exited (${code}): ${stderr}`)))
  for (const pipe of [child.stdio[3], child.stdio[4]]) pipe.on('error', fail)
  const send = (method, params = {}, sessionId, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, timeoutMs)
    pending.set(id, { resolve, reject, timer, method, sessionId, contextId: params.contextId })
    child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0')
  })
  const configure = async (sessionId, info) => {
    sessions.set(sessionId, info)
    await send('Runtime.enable', {}, sessionId)
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
    if (['page', 'iframe'].includes(info.type)) {
      await send('Page.enable', {}, sessionId)
      await send('Log.enable', {}, sessionId)
      await send('Network.enable', {}, sessionId)
      const { frameTree } = await send('Page.getFrameTree', {}, sessionId)
      const remember = tree => {
        frames.set(tree.frame.id, tree.frame.url)
        for (const child of tree.childFrames || []) remember(child)
      }
      remember(frameTree)
      await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId)
    }
    await send('Runtime.runIfWaitingForDebugger', {}, sessionId)
  }
  child.stdio[4].on('data', bytes => {
    buffer += bytes.toString()
    let index
    while ((index = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      if (message.id) {
        const entry = pending.get(message.id)
        if (entry) {
          pending.delete(message.id)
          clearTimeout(entry.timer)
          if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
          else entry.resolve(message.result)
        }
        continue
      }
      const { method, params, sessionId } = message
      if (['Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Target.detachedFromTarget'].includes(method)) {
        const affectedSession = params?.sessionId ?? sessionId
        for (const [id, entry] of pending) {
          if (entry.sessionId !== affectedSession) continue
          if (method !== 'Target.detachedFromTarget' && entry.method !== 'Runtime.evaluate') continue
          if (method === 'Runtime.executionContextDestroyed' && entry.contextId !== params.executionContextId) continue
          pending.delete(id); clearTimeout(entry.timer)
          entry.reject(new Error('Chrome execution context was destroyed'))
        }
      }
      if (method === 'Runtime.exceptionThrown') {
        exceptions.push({ sessionId, ...params })
        if (exceptions.length > 30) exceptions.shift()
      }
      if (method === 'Page.frameNavigated') frames.set(params.frame.id, params.frame.url)
      if (method === 'Target.attachedToTarget') configure(params.sessionId, params.targetInfo).catch(error => logs.push(String(error)))
      if (method === 'Runtime.executionContextCreated') contexts.set(`${sessionId}:${params.context.id}`, { ...params.context, sessionId })
      if (method === 'Runtime.executionContextDestroyed') contexts.delete(`${sessionId}:${params.executionContextId}`)
      if (method === 'Runtime.executionContextsCleared' || method === 'Target.detachedFromTarget') {
        for (const [key, context] of contexts) if (context.sessionId === (params?.sessionId ?? sessionId)) contexts.delete(key)
      }
      if (method === 'Runtime.exceptionThrown' || method === 'Log.entryAdded' || (method === 'Network.responseReceived' && params.response.url.includes('__tests__')) || (method === 'Runtime.consoleAPICalled' && ['error', 'warn'].includes(params.type))) {
        logs.push({ method, sessionId, params })
        if (logs.length > 150) logs.shift()
      }
      if (method === 'Fetch.requestPaused') {
        Promise.resolve(intercept(params.request)).then(response => {
          if (response === false) return send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'InternetDisconnected' }, sessionId)
          if (response) return send('Fetch.fulfillRequest', { requestId: params.requestId, ...response }, sessionId)
          return send('Fetch.continueRequest', { requestId: params.requestId }, sessionId)
        }).catch(error => logs.push(String(error)))
      }
    }
  })
  const until = async (check, label, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs
    let lastError
    while (Date.now() < deadline) {
      if (stopped) break
      try { const value = await check(); if (value) return value } catch (error) { lastError = error }
      await delay(100)
    }
    throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`)
  }
  // The trusted bridge iframe shares the app's origin but is not the app document.
  const contextFor = origin => [...contexts.values()].find(context => context.origin === origin && context.auxData?.isDefault && !frames.get(context.auxData.frameId)?.includes('/~~napp'))
  const evaluate = async (expression, origin = 'http://localhost:10000') => {
    const context = await until(() => contextFor(origin), `context ${origin}`)
    const response = await send('Runtime.evaluate', { expression, contextId: context.id, returnByValue: true, awaitPromise: true, userGesture: true }, context.sessionId)
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
    return response.result.value
  }
  const close = async () => {
    if (stopped) return
    stopped = true
    if (child.exitCode === null && child.signalCode === null) {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      await send('Browser.close').catch(() => child.kill('SIGTERM'))
      await exited
      clearTimeout(timer)
    }
    await proxy?.close()
    await rm(profile, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 })
  }
  try {
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const sessionId = await until(() => [...sessions].find(([, info]) => info.targetId === targetId)?.[0], 'Chrome page')
    return {
      send, evaluate, until, contexts, logs, close, profile,
      navigate: url => send('Page.navigate', { url }, sessionId),
      async diagnose (directory) {
        await mkdir(directory, { recursive: true })
        await writeFile(path.join(directory, 'browser.json'), JSON.stringify({ stderr, exceptions, logs, contexts: [...contexts.values()] }, null, 2))
        for (const origin of new Set([...contexts.values()].filter(context => context.auxData?.isDefault && context.origin.startsWith('http://')).map(context => context.origin))) {
          try { await writeFile(path.join(directory, new URL(origin).host.replaceAll(':', '-') + '.html'), await evaluate('document.documentElement.outerHTML', origin)) } catch {}
        }
        try {
          const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
          await writeFile(path.join(directory, 'failure.png'), Buffer.from(data, 'base64'))
        } catch {}
        try { await writeFile(path.join(directory, 'launcher.html'), await evaluate('document.documentElement.outerHTML')) } catch {}
      }
    }
  } catch (error) { await close(); throw error }
}
