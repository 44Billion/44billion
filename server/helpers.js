import { createServer as netCreateServer, isIP } from 'node:net' // simpler then 'node:http''s createServer

export function replyWithError (res, error = { base: ['Resource not found'] }) {
  try {
    if (res.writableEnded) {
      console.log('won\'t reply with error because already replied')
      return
    }
    if (!res.headersSent) {
      res.setHeader('content-type', 'application/json')
      res.writeHead(404)
    }
    res.end(JSON.stringify({ error }))
  } catch (err) {
    console.error('replyWithError error:', err)
  }
}

export function withWebUrl (req) {
  // we use req.headers.host because cf won't set x-forwarded-host automatically
  req.webUrl ??= new URL(`${
    req.headers['x-forwarded-proto'] || 'http'
  }://${
    req.headers.host
  }${req.url}`)
}
const isDev = process.env.NODE_ENV !== 'production'
export function withDomains (req) {
  withWebUrl(req)
  req.domain ??= ''
  req.subdomain = isIP(req.webUrl.hostname)
    ? ''
    : ((subdomain = '', dotCount = isDev ? 1 /* xyz.localhost */ : 0, str = req.webUrl.hostname) => {
        for (let i = str.length - 1; i >= 0; i--) {
          if (dotCount === 2) subdomain = str[i] + subdomain
          else {
            if (str[i] === '.') dotCount++
            if (dotCount < 2) req.domain = str[i] + req.domain
          }
        }
        return subdomain
      })()
}
export function withQuery (req) {
  withWebUrl(req)
  req.query ??= (() => {
    const query = {}
    let k
    let v
    for ([k, v] of req.webUrl.searchParams) query[k] = query[k] ? Array.prototype.concat(query[k], v) : v
    return query
  })()
}

export async function findFreePort (startPort = 10000) {
  let port = startPort

  while (true) {
    const isAvailable = await isPortAvailable(port)
    if (isAvailable) return port
    port++
  }
}
function isPortAvailable (port) {
  return new Promise((resolve) => {
    const server = netCreateServer()

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false) // Port is in use
      } else {
        resolve(false) // Some other error
      }
    })

    server.once('listening', () => {
      server.close()
      resolve(true) // Port is available
    })

    server.listen(port)
  })
}
