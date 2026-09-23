import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SourceMap } from 'node:module'
import { runInNewContext } from 'node:vm'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as esbuild from 'esbuild'
import { createSourceMaps } from '../../bin/sourcemaps.js'
import { createBuildOutput } from '../../bin/build-output.js'
import jsTextPlugin from '../../bin/plugins/js-text.js'
import swModulePlugin from '../../bin/plugins/sw-module.js'

const mapUrl = code => code.match(/\/\/# sourceMappingURL=(\S+)\s*$/)?.[1]
async function fixture (t, enabled, extraPlugins = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'launcher-maps-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'src/service-workers/app'), { recursive: true })
  const sources = {
    'src/main.js': 'import code from "./bridge.txt.js";\nglobalThis.injected = code;\nglobalThis.probe = () => { throw new Error("main-marker") };',
    'src/bridge.txt.js': '\nglobalThis.probe = () => {\n  throw new Error("bridge-marker")\n};',
    'src/service-workers/app/index.js': '\nconst VERSION = LAUNCHER_SW_VERSION;\nglobalThis.probe = () => {\n  throw new Error("worker-marker")\n};'
  }
  for (const [file, text] of Object.entries(sources)) await writeFile(path.join(root, file), text)
  const outdir = path.join(root, 'dist')
  const maps = createSourceMaps({ enabled, root })
  const output = createBuildOutput(maps, outdir)
  const ctx = await esbuild.context({
    absWorkingDir: root, entryPoints: ['src/main.js', { in: 'src/service-workers/app/index.js', out: 'app-sw' }],
    outdir, bundle: true, write: false, minify: true, format: 'esm',
    sourcemap: enabled ? 'external' : false,
    plugins: [...extraPlugins, jsTextPlugin(maps), swModulePlugin, output.plugin]
  })
  t.after(() => ctx.dispose())
  await ctx.rebuild()
  return { root, output, ctx, sources }
}
function assertLocation (files, code, marker, source, line) {
  const url = mapUrl(code)
  assert.match(url, /^\/~~sourcemaps\/[a-f0-9]{64}\.map$/)
  const json = JSON.parse(files.get(url))
  assert.equal(json.sources.length, json.sourcesContent.length)
  assert.ok(json.sources.every(source => !source.startsWith('/') && !source.includes('/tmp/')))
  const offset = code.indexOf(marker)
  assert.ok(offset >= 0)
  const prefix = code.slice(0, offset).split('\n')
  const entry = new SourceMap(json).findEntry(prefix.length - 1, prefix.at(-1).length)
  assert.equal(entry.originalSource, source)
  assert.equal(entry.originalLine, line - 1)
}

test('minified entry, composed worker and injected script map to original source lines', async t => {
  const { output } = await fixture(t, true)
  const main = output.files.get('/main.js').toString()
  assertLocation(output.files, main, 'main-marker', 'src/main.js', 3)
  assertLocation(output.files, output.files.get('/app-sw.js').toString(), 'worker-marker', 'src/service-workers/app/index.js', 4)
  const scope = {}
  runInNewContext(main, scope)
  assertLocation(output.files, scope.injected, 'bridge-marker', 'src/bridge.txt.js', 3)
  assert.match(scope.injected, /sourceURL=\/~~injected\/bridge.txt.js/)
  assert.ok(!scope.injected.includes('sourceMappingURL=data:'))
})

test('disabled flag removes maps and references across nested builds', async t => {
  const { output } = await fixture(t, false)
  assert.ok([...output.files.keys()].every(url => !url.endsWith('.map')))
  for (const bytes of output.files.values()) assert.ok(!bytes.toString().includes('sourceMappingURL='))
})

test('development publishes a complete rebuilt snapshot, retires old maps and streams reload events', async t => {
  const { output, root, ctx, sources } = await fixture(t, true)
  const server = await output.serve({ port: 0 })
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const oldUrl = mapUrl(output.files.get('/main.js').toString())
  const initial = await fetch(base + oldUrl)
  assert.equal(initial.status, 200)
  assert.equal(initial.headers.get('content-type'), 'application/json')
  assert.equal(initial.headers.get('cache-control'), 'no-store')
  await initial.body.cancel()
  const controller = new AbortController()
  t.after(() => controller.abort())
  const events = await fetch(base + '/esbuild', { signal: controller.signal })
  const reader = events.body.getReader()
  await reader.read()
  await writeFile(path.join(root, 'src/main.js'), '// changed comment\n' + sources['src/main.js'])
  await ctx.rebuild()
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: change/)
  controller.abort()
  const current = await (await fetch(base + '/main.js')).text()
  assert.notEqual(mapUrl(current), oldUrl)
  assert.equal((await fetch(base + oldUrl)).status, 404)
  assert.equal((await fetch(base + mapUrl(current))).status, 200)
  // Even unchanged injected scripts retain their corresponding maps on rebuild.
  const scope = {}
  runInNewContext(current, scope)
  assert.equal((await fetch(base + mapUrl(scope.injected))).status, 200)
})

test('requests wait for finalization and a failed rebuild retains the previous complete output', async t => {
  let delayedBuild = false
  const hold = Promise.withResolvers()
  const reached = Promise.withResolvers()
  const delayed = {
    name: 'delayed-entry', setup (build) {
      build.onLoad({ filter: /main\.js$/ }, async () => { if (delayedBuild) { reached.resolve(); await hold.promise }; return undefined })
    }
  }
  const { output, root, ctx, sources } = await fixture(t, true, [delayed])
  const server = await output.serve({ port: 0 })
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const original = output.files.get('/main.js').toString()
  delayedBuild = true
  await writeFile(path.join(root, 'src/main.js'), sources['src/main.js'] + '\nconsole.log("next build")')
  const rebuild = ctx.rebuild()
  await reached.promise
  let delivered = false
  const response = fetch(base + '/main.js').then(async r => { delivered = true; return r.text() })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(delivered, false)
  hold.resolve()
  await rebuild
  const current = await response
  assert.notEqual(current, original)
  assert.equal((await fetch(base + mapUrl(current))).status, 200)
  await writeFile(path.join(root, 'src/main.js'), 'export {')
  await assert.rejects(ctx.rebuild(), /Build failed/)
  assert.equal(await (await fetch(base + '/main.js')).text(), current)
  assert.equal((await fetch(base + mapUrl(current))).status, 200)
})
