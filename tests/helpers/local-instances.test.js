import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const deleted = []
let originFailure = false
mock.module('#services/local-dev/install.js', { namedExports: { pruneLocalVersions: async () => {} } })
mock.module('#services/app-file-manager/manifest-instance-cache.js', { namedExports: { replaceCachedSiteManifest: async () => {} } })
mock.module('#services/idb/browser/queries/site-manifest.js', { namedExports: { getSiteManifestFromDb: async () => ({}) } })
mock.module('#zones/screen/helpers/draft-app-runtime-reset.js', {
  namedExports: {
    askAppToClearData: async (subdomain, options) => {
      assert.equal(subdomain, '0'); assert.equal(options.strict, true)
      if (originFailure) throw new Error('Origin cleanup failed')
    }
  }
})
mock.module('#services/idb/nostrdb/index.js', {
  namedExports: {
    getNostrDb: owner => ({ deleteEventsByApp: async appId => deleted.push({ owner, appId }) })
  }
})

test('reset pauses only the selected user/app and resumes instances after partial failure', { timeout: 3000 }, async t => {
  const oldStorage = globalThis.localStorage
  const oldDevelopment = globalThis.IS_DEVELOPMENT
  const oldChannel = globalThis.BroadcastChannel
  globalThis.IS_DEVELOPMENT = true
  const data = JSON.stringify({ app: { version: 'v1' }, other: { version: 'v1' } })
  globalThis.localStorage = { getItem: () => data }
  globalThis.BroadcastChannel = class { postMessage () {} }
  const controllers = []
  t.after(() => {
    controllers.forEach(controller => controller.abort())
    globalThis.BroadcastChannel = oldChannel
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage
    if (oldDevelopment === undefined) delete globalThis.IS_DEVELOPMENT; else globalThis.IS_DEVELOPMENT = oldDevelopment
  })
  const { attachLocalInstance, clearLocalAppData } = await import('#services/local-dev/instances.js')
  const counts = []
  for (const [appId, userPk] of [['app', '1'], ['app', '1'], ['app', '2'], ['other', '1']]) {
    const controller = new AbortController(); controllers.push(controller)
    const count = { paused: 0, reloaded: 0 }; counts.push(count)
    await attachLocalInstance({ appId, userPk, signal: controller.signal, pause: async () => { count.paused++ }, reload: async () => { count.reloaded++ } })
  }
  const settle = async expected => {
    for (let step = 0; step < 100; step++) {
      if (counts[0].reloaded === expected && counts[1].reloaded === expected) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.fail('Paused instances did not resume')
  }
  await clearLocalAppData({ appId: 'app', userPk: '1', appSubdomain: '0' })
  await settle(1)
  assert.deepEqual(counts, [{ paused: 1, reloaded: 1 }, { paused: 1, reloaded: 1 }, { paused: 0, reloaded: 0 }, { paused: 0, reloaded: 0 }])
  assert.deepEqual(deleted, [{ appId: 'app', owner: '1'.padStart(64, '0') }])
  originFailure = true
  await assert.rejects(clearLocalAppData({ appId: 'app', userPk: '1', appSubdomain: '0' }), error => error instanceof AggregateError && error.errors[0].message === 'Origin cleanup failed')
  await settle(2)
  assert.equal(counts[2].paused, 0)
  assert.equal(counts[3].paused, 0)
})
