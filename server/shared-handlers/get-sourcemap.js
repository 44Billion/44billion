import { readFile } from 'node:fs/promises'

const root = new URL('../../dist/44billion/', import.meta.url)
// This file lives under server/shared-handlers, so the build is two levels up.
export async function getSourceMap (req, res, { development = process.env.NODE_ENV === 'development', directory = root } = {}) {
  const { pathname } = req.webUrl
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json')
  const match = /^\/~~sourcemaps\/([a-f0-9]{64}\.map)$/.exec(pathname)
  if (!match || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(404); res.end(); return res
  }
  try {
    let bytes
    if (development) {
      const response = await fetch(`http://127.0.0.1:8080${pathname}`, { cache: 'no-store' })
      if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json')) {
        await response.body?.cancel()
        res.writeHead(404); res.end(); return res
      }
      bytes = Buffer.from(await response.arrayBuffer())
    } else {
      bytes = await readFile(new URL(`~~sourcemaps/${match[1]}`, directory))
    }
    res.writeHead(200)
    res.end(req.method === 'HEAD' ? undefined : bytes)
  } catch (error) {
    if (error.code !== 'ENOENT' && !development) throw error
    res.writeHead(development ? 503 : 404); res.end()
  }
  return res
}
