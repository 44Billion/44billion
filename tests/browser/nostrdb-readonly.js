// Two tabs, real IndexedDB/Web Locks/storage notifications and production cleanup.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { launchChrome } from './runtime/chrome.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  define: { IS_DEVELOPMENT: 'false', IS_PRODUCTION: 'true' },
  stdin: {
    resolveDir: root, contents: `
    import { getNostrDb, openNostrDb, deleteNostrDbAppData } from './src/services/idb/nostrdb/index.js';
    import { reconcileNostrDbAccounts } from './src/services/nostrdb-account-lifecycle.js';
    import { QUOTA_LOCK } from './src/services/idb/nostrdb/quotas.js';
    import { finalizeEvent } from 'libp2r2p/event';
    import { getPublicKey } from 'libp2r2p/key';
    const secret = new Uint8Array(32).fill(93);
    const owner = getPublicKey(secret);
    globalThis.fixture = {
      owner, QUOTA_LOCK, getNostrDb, openNostrDb, deleteNostrDbAppData,
      change: isReadOnly => reconcileNostrDbAccounts([{pubkey:owner,isReadOnly}]),
      resume: () => reconcileNostrDbAccounts([]),
      async setup() {
        this.db = getNostrDb(owner, {maintenance:false});
        await this.db.add(finalizeEvent({kind:1,created_at:123,tags:[],content:'retained'},secret));
        this.stream = this.db.subscribe({kinds:[1]});
        this.pending = this.stream.next().then(()=> 'delivered', error=>error.code);
      },
      fresh: () => getNostrDb(owner,{maintenance:false}).count({}),
      names: () => indexedDB.databases().then(dbs=>dbs.map(db=>db.name))
    };
  `
  }
})
const origin = 'http://localhost:10000'
const browser = await launchChrome({
  intercept: request => request.url.startsWith(origin + '/')
    ? {
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: request.url.endsWith('/fixture.js') ? 'text/javascript' : 'text/html' }],
        body: Buffer.from(request.url.endsWith('/fixture.js') ? bundle.outputFiles[0].text : '<!doctype html><script type="module" src="/fixture.js"></script>').toString('base64')
      }
    : null
})
async function evaluate (context, expression) {
  const reply = await browser.send('Runtime.evaluate', { expression, contextId: context.id, awaitPromise: true, returnByValue: true }, context.sessionId)
  if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails))
  return reply.result.value
}
try {
  await browser.navigate(origin + '/one')
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const second = await browser.until(() => [...browser.contexts.values()].find(c => c.auxData?.frameId === targetId && c.auxData?.isDefault), 'second tab attached')
  await browser.send('Page.navigate', { url: origin + '/two' }, second.sessionId)
  const contexts = await browser.until(() => {
    const tabs = [...browser.contexts.values()].filter(c => c.origin === origin && c.auxData?.isDefault)
    return tabs.length === 2 && tabs
  }, 'two same-origin tabs')
  const [one, two] = contexts
  await browser.until(async () => (await Promise.all(contexts.map(c => evaluate(c, '!!globalThis.fixture')))).every(Boolean), 'fixture modules')
  await evaluate(one, 'fixture.setup()')
  await evaluate(two, 'fixture.setup()')
  // Both instances retain open connections and idle streams. Delay cleanup to
  // exercise an in-flight operation and a rapid return to writable access.
  await evaluate(one, 'void navigator.locks.request(fixture.QUOTA_LOCK,()=>new Promise(resolve=>{globalThis.release=resolve}))')
  await browser.until(() => evaluate(one, '!!globalThis.release'), 'quota barrier')
  await evaluate(one, 'void (globalThis.transition=fixture.change(true))')
  await browser.until(() => evaluate(two, '!!localStorage.local_nostrDbPendingDeletions'), 'durable deletion intent in peer tab')
  assert.equal(await evaluate(one, 'fixture.pending'), 'READ_ONLY_ACCOUNT')
  assert.equal(await evaluate(two, 'fixture.pending'), 'READ_ONLY_ACCOUNT')
  assert.equal(await evaluate(two, 'fixture.db.query({}).catch(error=>error.code)'), 'READ_ONLY_ACCOUNT')
  await evaluate(two, 'void (globalThis.writable=fixture.change(false))')
  await evaluate(one, 'release()')
  await evaluate(one, 'transition')
  await evaluate(two, 'writable')
  assert.equal(await evaluate(two, 'localStorage.local_nostrDbPendingDeletions ?? null'), null)
  assert.equal(await evaluate(two, 'fixture.fresh()'), 0)
  assert.equal(await evaluate(one, 'fixture.db.count({}).catch(error=>error.code)'), 'READ_ONLY_ACCOUNT')

  // Model interruption after recording intent but before completing deletion.
  await evaluate(two, 'localStorage.local_nostrDbPendingDeletions=JSON.stringify({[fixture.owner]:"interrupted"})')
  await browser.send('Page.reload', {}, two.sessionId)
  const reloaded = await browser.until(() => [...browser.contexts.values()].find(c => c.origin === origin && c.auxData?.isDefault && c.sessionId === two.sessionId && c.id !== two.id), 'reloaded tab')
  await browser.until(() => evaluate(reloaded, '!!globalThis.fixture'), 'reload fixture')
  assert.equal(await evaluate(reloaded, '(()=>{try{fixture.getNostrDb(fixture.owner);return "opened"}catch(error){return error.code}})()'), 'NOSTRDB_DELETION_PENDING')
  await evaluate(reloaded, 'fixture.resume()')
  assert.equal(await evaluate(reloaded, 'fixture.names().then(names=>names.includes("44billion_nostrdb:"+fixture.owner))'), false)
  await evaluate(reloaded, 'fixture.change(true)')
  assert.equal(await evaluate(reloaded, 'fixture.openNostrDb(fixture.owner).catch(error=>error.code)'), 'READ_ONLY_ACCOUNT')
  await evaluate(reloaded, 'fixture.deleteNostrDbAppData(fixture.owner,"app")')
  assert.equal(await evaluate(reloaded, 'fixture.names().then(names=>names.includes("44billion_nostrdb:"+fixture.owner))'), false)
  console.log('Read-only lifecycle: two tabs, idle subscriptions, retained instances, rapid writable transition, reload recovery and absent cleanup passed.')
} catch (error) { console.error('Read-only diagnostics:', JSON.stringify(browser.logs)); throw error } finally { await browser.close() }
