import { createServer } from 'node:http'
import {
  withWebUrl,
  withDomains,
  replyWithError,
  findFreePort
} from './helpers.js'
import {
  subdomainAppRouter
} from './router/index.js'

// dev server, but router is also used at production
const server = createServer(async function httpHandler (req, res) {
  try {
    withWebUrl(req)
    logReqRes(req, res, 'http')
    withDomains(req)
    if (!req.domain && req.webUrl.hostname !== '127.0.0.1') return replyWithError(res)
    if (req.domain !== '44billion.net' && req.domain !== 'localhost') return replyWithError(res)

    console.log('req.webUrl', req.webUrl)
    if (req.subdomain && req.subdomain.split('.')[0].length === req.subdomain.length) {
      console.log('entered app router')
      await subdomainAppRouter.fetch(req, res)
    }

    if (!res.writableEnded) await maybeProxyToEsbuild(req, res)

    if (!res.writableEnded) replyWithError(res)
  } catch (err) {
    console.error(err)
    replyWithError(res)
  }
})
const port = await findFreePort()
server
  .listen(port)
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
process.on('SIGINT', async function () {
  console.log('Ctrl-C was pressed')
  await new Promise(resolve => server.close(resolve))
  console.log('stopped dev-server')
})

function logReqRes (req, res, mode = 'http') {
  console.log(`${req.method} ${req.url} (fwd: ${req.headers['x-forwarded-for'] ?? 'none'} - sckt: ${req.socket.remoteAddress})`)
  req.on('error', err => { console.error(`${mode === 'ws' ? '(Websocket) ' : ''}Request error: ${err.stack}`) })
  res.on('error', err => { console.error(`${mode === 'ws' ? '(Websocket) ' : ''}Response error: ${err.stack}`) })
}

async function maybeProxyToEsbuild (req, res) {
  const isDev = process.env.NODE_ENV === 'development'
  if (!isDev) return

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
