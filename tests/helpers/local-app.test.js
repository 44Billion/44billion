import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { localIdentity, prepareLocalApp } from '../../bin/local-app.js'
import { createLocalAppServer } from '../../server/local-app-server.js'

const file = (name, contents) => ({ name, bytes: new TextEncoder().encode(contents) })
const files = [file('index.html', '<title>Local</title><link rel="icon" href="icon.svg">'), file('icon.svg', '<svg/>'), file('app.js', 'one'), file('.well-known/napp.json', JSON.stringify({ name: [['Local app']], summary: [['Summary', 'en']] }))]

test('local identity survives restarts, stays private and rejects malformed state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'local-identity-'))
  try {
    assert.deepEqual(await localIdentity(root), await localIdentity(root))
    const filename = path.join(root, 'tmp/local-dev/identity.json')
    assert.equal((await stat(filename)).mode & 0o777, 0o600)
    await writeFile(filename, '{"secret":"invalid"}')
    await assert.rejects(localIdentity(root), /Invalid local development identity/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('local revisions include metadata, preserve identity and exclude private build metadata', () => {
  const secret = new Uint8Array(32).fill(1)
  const first = prepareLocalApp(files, { secret, identifier: 'local-test', createdAt: 10 })
  const repeated = prepareLocalApp(files, { secret, identifier: 'local-test', createdAt: 11 })
  assert.equal(first.revision, repeated.revision)
  assert.equal(first.app, repeated.app)
  assert.notEqual(first.manifest.id, repeated.manifest.id)
  assert.ok(!first.assets.some(asset => asset.name.includes('.well-known')))
  assert.ok(first.manifest.tags.some(tag => tag[0] === 'r' && tag.includes('icon')))
  const changed = prepareLocalApp(files.map(item => item.name.endsWith('napp.json') ? file(item.name, '{"name":[["Changed"]]}') : item), { secret, identifier: 'local-test' })
  assert.notEqual(first.revision, changed.revision)
  assert.equal(first.appId, changed.appId)
  assert.throws(() => prepareLocalApp([...files, file('../escape', '')], { secret }), /Invalid local asset path/)
})

test('local server requires control credentials and serves only registered immutable bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'local-server-'))
  const original = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
  const local = await createLocalAppServer(root)
  const server = createServer((req, res) => local.handle(req, res).then(handled => { if (!handled) res.writeHead(404).end() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const { token } = JSON.parse(await readFile(path.join(root, 'tmp/local-dev-session.json'), 'utf8'))
  const build = prepareLocalApp(files, { secret: new Uint8Array(32).fill(2) })
  const request = (route, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(origin + route, { ...options, headers: { host: 'localhost:10000', ...options.headers } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })))
    })
    req.on('error', reject)
    req.end(options.body)
  })
  try {
    const options = { method: 'POST', body: JSON.stringify(build) }
    assert.equal((await request('/__dev/apps/register', options)).status, 403)
    const headers = { authorization: `Bearer ${token}`, 'x-local-owner': 'watcher-1' }
    assert.equal((await request('/__dev/apps/register', { ...options, headers: { ...headers, origin: 'https://untrusted.example' } })).status, 403)
    assert.equal((await request('/__dev/apps/register', { ...options, headers })).status, 200)
    const url = `/__dev/apps/build?project=${encodeURIComponent(build.project)}`
    const descriptor = await (await request(url)).json()
    assert.equal(descriptor.revision, build.revision)
    assert.ok(descriptor.assets.every(asset => !Object.hasOwn(asset, 'body')))
    const asset = descriptor.assets.find(asset => asset.name === 'app.js')
    const fileResponse = await request(`/__dev/apps/file?${new URLSearchParams({ project: build.project, revision: build.revision, root: asset.root })}`)
    assert.equal(await fileResponse.text(), 'one')
    assert.equal(fileResponse.headers.get('content-disposition'), 'attachment')
    assert.ok(fileResponse.headers.get('content-security-policy').includes('sandbox'))
    assert.equal((await request('/__dev/apps/file?path=/etc/passwd')).status, 404)
    assert.equal((await request('/__dev/apps/unregister', { method: 'POST', headers: { ...headers, 'x-local-owner': 'watcher-2' }, body: JSON.stringify({ project: build.project }) })).status, 409)
    assert.equal((await request(url)).status, 200)
    assert.equal((await request('/__dev/apps/unregister', { method: 'POST', headers, body: JSON.stringify({ project: build.project }) })).status, 200)
    assert.equal((await request(url)).status, 404)
    process.env.NODE_ENV = 'production'
    assert.equal((await request(url)).status, 403)
  } finally {
    if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original
    await local.close(); server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
