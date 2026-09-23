import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getSourceMap } from '../../../server/shared-handlers/get-sourcemap.js'

function response () {
  return {
    headers: {}, setHeader (key, value) { this.headers[key] = value },
    writeHead (status) { this.status = status }, end (body) { this.body = body }
  }
}
const hash = 'a'.repeat(64)
const mapPath = `/~~sourcemaps/${hash}.map`
const request = (pathname = mapPath, method = 'GET') => ({ webUrl: new URL(pathname, 'http://localhost'), method })

test('map handler serves only exact build artifacts as uncached JSON, including HEAD', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'serve-maps-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '~~sourcemaps'))
  await writeFile(path.join(root, '~~sourcemaps', hash + '.map'), '{"version":3}')
  const options = { development: false, directory: pathToFileURL(root + '/') }
  for (const method of ['GET', 'HEAD']) {
    const res = response()
    await getSourceMap(request(mapPath, method), res, options)
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/json')
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(res.body?.toString(), method === 'HEAD' ? undefined : '{"version":3}')
  }
  for (const pathname of [mapPath.replace(hash, 'b'.repeat(64)), '/~~sourcemaps/app.js.map', '/~~sourcemaps/%2fetc%2fpasswd.map', '/~~sourcemaps/../package.json', '/~~sourcemaps/nested/' + hash + '.map']) {
    const res = response()
    await getSourceMap(request(pathname), res, options)
    assert.equal(res.status, 404)
    assert.equal(res.body, undefined)
  }
})

test('development never forwards HTML fallback as a source map', async t => {
  for (const status of [200, 404]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html>fallback</html>', { status, headers: { 'content-type': 'text/html' } }))
    const res = response()
    await getSourceMap(request(), res, { development: true })
    assert.equal(res.status, 404)
  }
})

test('shared router reserves maps on root and app origins before app bootstrap handling', async t => {
  const seen = []
  t.mock.module('../../../server/shared-handlers/get-sourcemap.js', {
    namedExports: { getSourceMap: req => { seen.push(req.subdomain); return 'map' } }
  })
  const { default: router } = await import('../../../server/router/index.js')
  for (const subdomain of ['', '123']) {
    assert.equal(await router.fetch({ ...request(), subdomain }, {}), 'map')
  }
  assert.deepEqual(seen, ['', '123'])
})
