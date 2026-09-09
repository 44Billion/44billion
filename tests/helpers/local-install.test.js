import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

let manifest = { id: 'old' }
let writes = []
let failWrite = false
let leased = new Set()
mock.module('#services/idb/browser/queries/file-chunk.js', {
  namedExports: {
    saveFileChunksToDB: async (_manifest, _events, _appId, { rootHash }) => { if (failWrite) throw new Error('Storage quota exceeded'); writes.push(rootHash) },
    deleteStaleFileChunksFromDb: async (_appId, roots) => { writes = writes.filter(root => roots.includes(root)) }
  }
})
mock.module('#services/idb/browser/queries/site-manifest.js', {
  namedExports: {
    getSiteManifestFromDb: async () => manifest,
    saveSiteManifestToDb: async next => { manifest = next }
  }
})
const { installLocalBuild, pruneLocalVersions } = await import('#services/local-dev/install.js')
const { readLocalApps } = await import('#services/local-dev/state.js')

// Controlled storage boundaries exercise failed writes independently of browser networking.
test('local installation preserves the previous build on bad bytes or quota failure and retains leased roots', async t => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const oldStorage = globalThis.localStorage
  const oldDevelopment = globalThis.IS_DEVELOPMENT
  const records = new Map()
  globalThis.IS_DEVELOPMENT = true
  globalThis.localStorage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: {
      locks: {
        request: async (name, options, callback) => (callback ?? options)(leased.has(name) ? null : {})
      }
    }
  })
  t.after(() => {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage
    if (oldDevelopment === undefined) delete globalThis.IS_DEVELOPMENT; else globalThis.IS_DEVELOPMENT = oldDevelopment
  })
  const bytes = new TextEncoder().encode('valid')
  const root = createHash('sha256').update(bytes).digest('hex')
  records.set('local_devApps', JSON.stringify({ app: { project: 'app', version: 'old', versions: { old: ['old-root'] } } }))
  writes = ['old-root']
  const build = { appId: 'app', project: 'app', revision: 'new', assets: [{ name: 'app.js', root, size: bytes.length }], manifest: { id: 'new' } }
  const activate = async (_id, next) => { manifest = next }
  await assert.rejects(installLocalBuild(build, { loadAsset: async () => new Uint8Array(bytes.length), activate }), /digest mismatch/)
  assert.equal(manifest.id, 'old')
  assert.deepEqual(writes, ['old-root'])
  failWrite = true
  await assert.rejects(installLocalBuild(build, { loadAsset: async () => bytes, activate }), /quota/)
  assert.equal(readLocalApps().app.version, 'old')
  failWrite = false
  leased = new Set(['local-dev:version:app:old'])
  await installLocalBuild(build, { loadAsset: async () => bytes, activate })
  assert.equal(manifest.id, 'new')
  assert.deepEqual(new Set(writes), new Set(['old-root', root]))
  leased.clear()
  await pruneLocalVersions('app')
  assert.deepEqual(writes, [root])
  assert.deepEqual(Object.keys(readLocalApps().app.versions), ['new'])
  assert.equal(await installLocalBuild(build, { loadAsset: () => { throw new Error('Unchanged build must not download') }, activate }), false)
})
