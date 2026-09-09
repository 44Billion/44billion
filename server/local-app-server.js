import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'

const MAX_BYTES = 64 * 1024 * 1024

// Serves only immutable registered bytes, never arbitrary paths from disk.
export async function createLocalAppServer (root) {
  const token = randomBytes(32).toString('hex')
  const filename = path.join(root, 'tmp/local-dev-session.json')
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  await writeFile(filename, JSON.stringify({ token }), { mode: 0o600 })
  const apps = new Map()
  const owners = new Map()
  const streams = new Set()
  const broadcast = (type, data) => {
    for (const stream of streams) stream.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const summary = build => ({ project: build.project, app: build.app, appId: build.appId, revision: build.revision })
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
  const authenticate = req => {
    const received = Buffer.from(req.headers.authorization || '')
    const expected = Buffer.from(`Bearer ${token}`)
    return received.length === expected.length && timingSafeEqual(received, expected)
  }
  const readJson = async req => {
    const chunks = []; let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BYTES) throw new Error('Local build exceeds 64 MiB transfer limit')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString())
  }
  return {
    async handle (req, res) {
      const url = new URL(req.url, 'http://localhost:10000')
      if (!url.pathname.startsWith('/__dev/apps/')) return false
      const origin = 'http://localhost:10000'
      if (process.env.NODE_ENV !== 'development' || req.headers.host !== 'localhost:10000' ||
          (req.headers.origin && req.headers.origin !== origin) ||
          (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
        json(res, 403, { error: 'Local development access only' }); return true
      }
      try {
        if (url.pathname === '/__dev/apps/events' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
          streams.add(res)
          for (const build of apps.values()) res.write(`event: build\ndata: ${JSON.stringify(summary(build))}\n\n`)
          const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000)
          res.on('close', () => { streams.delete(res); clearInterval(timer) })
          return true
        }
        if (url.pathname === '/__dev/apps/register' && req.method === 'POST') {
          if (!authenticate(req)) { json(res, 403, { error: 'Invalid supervisor token' }); return true }
          const build = await readJson(req)
          if (!build.project || build.project !== build.appId || !/^[0-9a-f]{64}$/.test(build.revision) || !Array.isArray(build.assets)) throw new Error('Invalid local build')
          for (const asset of build.assets) {
            const bytes = Buffer.from(asset.body, 'base64')
            if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.root) throw new Error('Local asset digest mismatch')
          }
          const changed = apps.get(build.project)?.revision !== build.revision
          apps.set(build.project, build)
          owners.set(build.project, req.headers['x-local-owner'] || '')
          if (changed) broadcast('build', summary(build))
          json(res, 200, summary(build)); return true
        }
        if (url.pathname === '/__dev/apps/unregister' && req.method === 'POST') {
          if (!authenticate(req)) { json(res, 403, { error: 'Invalid supervisor token' }); return true }
          const { project } = await readJson(req)
          const owner = req.headers['x-local-owner']
          if (!owner || owners.get(project) !== owner) { json(res, 409, { error: 'Registration belongs to another watcher' }); return true }
          apps.delete(project); owners.delete(project)
          json(res, 200, { ok: true }); return true
        }
        if (url.pathname === '/__dev/apps/report' && req.method === 'POST') {
          const report = await readJson(req)
          if (!apps.has(report.project) || typeof report.message !== 'string') throw new Error('Unknown local project')
          const data = { project: report.project, revision: report.revision, message: report.message.slice(0, 1000) }
          broadcast('report', data)
          json(res, 200, { ok: true }); return true
        }
        const project = url.searchParams.get('project')
        const build = apps.get(project)
        if (!build || req.method !== 'GET') { json(res, 404, { error: 'Local watcher is not serving this app' }); return true }
        if (url.pathname === '/__dev/apps/build') {
          json(res, 200, { ...build, assets: build.assets.map(({ body: _, ...asset }) => asset) }); return true
        }
        if (url.pathname === '/__dev/apps/file' && url.searchParams.get('revision') === build.revision) {
          const asset = build.assets.find(asset => asset.root === url.searchParams.get('root'))
          if (asset) { res.writeHead(200, { 'content-type': asset.mimeType, 'content-length': asset.size, 'cache-control': 'no-store', 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'" }); res.end(Buffer.from(asset.body, 'base64')); return true }
        }
        json(res, 404, { error: 'Local build was superseded; retry the latest build' })
      } catch (error) { json(res, 400, { error: error.message }) }
      return true
    },
    async close () { for (const stream of streams) stream.end(); await rm(filename, { force: true }) }
  }
}
