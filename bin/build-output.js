import { createServer } from 'node:http'
import mime from 'mime'
import { sourceMapPrefix } from './sourcemaps.js'

// Publish an entire successful build at once, including maps from nested builds.
export function createBuildOutput (maps, outdir, { ready = () => {} } = {}) {
  let files = new Map()
  let pending = Promise.withResolvers()
  let building = true
  const clients = new Set()
  const plugin = {
    name: 'build-output',
    setup (build) {
      build.onStart(() => {
        if (!building) pending = Promise.withResolvers()
        building = true
        maps.begin()
      })
      build.onEnd(result => {
        if (!result.errors.length) {
          const next = maps.finish(result.outputFiles, outdir)
          const changes = {
            added: [...next.keys()].filter(key => !files.has(key)),
            removed: [...files.keys()].filter(key => !next.has(key)),
            updated: [...next.keys()].filter(key => files.has(key) && !files.get(key).equals(next.get(key)))
          }
          const hadBuild = files.size > 0
          files = next
          if (hadBuild && Object.values(changes).some(list => list.length)) {
            for (const client of clients) client.write(`event: change\ndata: ${JSON.stringify(changes)}\n\n`)
          }
        }
        building = false
        pending.resolve()
        ready(result.errors.length === 0)
      })
    }
  }
  return {
    plugin,
    get files () { return files },
    serve ({ port = 8080, host = '127.0.0.1' } = {}) {
      const server = createServer(async (req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname
        res.setHeader('cache-control', 'no-store')
        if (pathname === '/esbuild') {
          res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
          res.write(': connected\n\n')
          clients.add(res)
          req.on('close', () => clients.delete(res))
          return
        }
        await pending.promise
        const htmlFallback = !pathname.startsWith(sourceMapPrefix) && (pathname === '/' || req.headers.accept?.includes('text/html'))
        const bytes = files.get(pathname) ?? (htmlFallback ? files.get('/index.html') : undefined)
        if (!bytes) { res.writeHead(404); res.end(); return }
        res.setHeader('content-type', pathname.startsWith(sourceMapPrefix) ? 'application/json' : (htmlFallback && !files.has(pathname) ? 'text/html' : (mime.getType(pathname) || 'application/octet-stream')))
        res.writeHead(200)
        res.end(req.method === 'HEAD' ? undefined : bytes)
      })
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => resolve(server))
      })
    }
  }
}
