import { createServer } from 'node:http'
import { access, realpath } from 'node:fs/promises'
import path from 'node:path'
import { launcherRoot, healthPath, runtimeProtocol } from '../bin/dev-runtime.js'
import {
  withWebUrl,
  withDomains,
  replyWithError
} from './helpers.js'
import router from './router/index.js'
import { createLocalAppServer } from './local-app-server.js'

const localApps = process.env.NODE_ENV === 'development' ? await createLocalAppServer(launcherRoot) : null

// dev server, but router is also used at production
const server = createServer(async function httpHandler (req, res) {
  try {
    if (await localApps?.handle(req, res)) return
    withWebUrl(req)
    if (process.env.NODE_ENV === 'development' && req.webUrl.hostname === 'localhost' && req.webUrl.pathname === healthPath) {
      let ready = false
      try {
        const response = await fetch('http://127.0.0.1:8080/app.js', { signal: AbortSignal.timeout(1500) })
        await response.body?.cancel()
        const vault = await fetch('http://127.0.0.1:4000/app.js', { signal: AbortSignal.timeout(1500) })
        await vault.body?.cancel()
        await access(path.resolve(launcherRoot, '../ez-vault/.dev/app.js'))
        await access(path.resolve(launcherRoot, '../ez-vault/.dev/index.html'))
        ready = response.ok && vault.ok
      } catch {}
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ service: '44billion', protocol: runtimeProtocol, root: await realpath(launcherRoot), ready }))
      return
    }
    withDomains(req)
    logReqRes(req, res, 'http')
    if (!req.domain && req.webUrl.hostname !== '127.0.0.1') return replyWithError(res)
    if (req.domain !== '44billion.net' && req.domain !== 'localhost') return replyWithError(res)

    if (!req.webUrl.pathname.endsWith('.js.map')) {
      await router.fetch(req, res)
    }

    // CAUTION: one needs to await rstream.pipe(res).on('finish', resolve)
    // or await pipeline(rstream, res) from 'node:stream/promises'
    // so that res.writableEnded is set to true
    if (!res.writableEnded) await maybeProxyToEsbuild(req, res)
    if (!res.writableEnded) replyWithError(res)
  } catch (err) {
    console.error(err)
    replyWithError(res)
  }
})
const port = 10000
server
  .listen(port, '127.0.0.1')
  .on('listening', () => console.log(`> Dev-server ready on http://localhost:${port}`))
  .on('close', () => console.log(`Server closed at ${new Date().toLocaleString('pt-br', { timeZone: 'America/Sao_Paulo' })}`))
  .on('error', error => {
    if (error.syscall !== 'listen') throw error
    ;({
      EACCES: () => { console.error(`Port ${port} requires elevated privileges`); process.kill(process.pid, 'SIGINT') },
      EADDRINUSE: () => { console.error(`Port ${port} is already in use`); process.kill(process.pid, 'SIGINT') },
      default: () => { throw error }
    }[error.code ?? 'default']?.())
  })
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async function () {
    await localApps?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    process.disconnect?.()
  })
}

function logReqRes (req, res, mode = 'http') {
  console.log(`${req.method} ${req.url} (sub: ${req.subdomain ?? 'none'} - fwd: ${req.headers['x-forwarded-for'] ?? 'none'} - sckt: ${req.socket.remoteAddress})`)
  req.on('error', err => { console.error(`${mode === 'ws' ? '(Websocket) ' : ''}Request error: ${err.stack}`) })
  res.on('error', err => { console.error(`${mode === 'ws' ? '(Websocket) ' : ''}Response error: ${err.stack}`) })
}

async function maybeProxyToEsbuild (req, res) {
  const isDev = process.env.NODE_ENV === 'development'
  if (!isDev) return

  console.log('esbuild router:', req.url)
  const url = httpReqToUrl(req, '8080') // esbuild server at default port
  const options = httpReqToFetchOptions(req)
  const response = await fetch(url, options)
  await fetchResponseToHttpRes(response, res)
}
function httpReqToUrl (req, port) {
  return `http://localhost:${port}${req.url}`
}
/**
 * Converts an HTTP request to fetch options, including method, headers, and body.
 */
function httpReqToFetchOptions (req) {
  const headers = { ...req.headers }
  delete headers['host'] // Remove 'host' header since we're specifying the URL with the port

  const options = {
    method: req.method,
    headers,
    // For non-GET/HEAD requests, include the request body as a stream
    body: (req.method !== 'GET' && req.method !== 'HEAD') ? req : undefined
  }

  // Include 'duplex' option when sending a body
  if (options.body) {
    options.duplex = 'half'
  }

  return options
}
/**
 * Writes the fetch response back to the HTTP response object.
 */
async function fetchResponseToHttpRes (response, res) {
  res.statusCode = response.status
  for (const [key, value] of response.headers.entries()) {
    res.setHeader(key, value)
  }
  if (!response.body) {
    res.end()
    return
  }

  const chunks = []
  for await (const chunk of response.body) {
    chunks.push(chunk)
  }
  res.write(Buffer.concat(chunks))
  res.end()
}
