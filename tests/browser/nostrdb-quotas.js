// Isolated production NostrDB modules, real IndexedDB/Web Locks, disposable profile.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { launchChrome } from './runtime/chrome.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, format: 'esm', platform: 'browser',
  stdin: {
    resolveDir: root, contents: `
    import { getNostrDb, deleteNostrDb, openNostrDb } from './src/services/idb/nostrdb/index.js';
    import * as quotas from './src/services/idb/nostrdb/quotas.js';
    import { finalizeEvent } from 'libp2r2p/event';
    import { getPublicKey } from 'libp2r2p/key';
    globalThis.fixture = {
      ...quotas, deleteNostrDb, openNostrDb,
      async setup(seed) {
        const secret = new Uint8Array(32).fill(seed);
        this.owner = getPublicKey(secret);
        this.db = getNostrDb(this.owner, { maintenance: false });
        await openNostrDb(this.owner);
        this.event = finalizeEvent({ kind: 1, created_at: 123, tags: [], content: 'ação 🌍' }, secret);
        return { owner: this.owner, bytes: new TextEncoder().encode(JSON.stringify(this.event)).length };
      }
    };
  `
  }
})
const origin = 'http://localhost:10000'
const browser = await launchChrome({
  intercept: request => {
    if (!request.url.startsWith(origin + '/__tests__/quotas')) return null
    return {
      responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      body: Buffer.from(`<script type="module">${bundle.outputFiles[0].text}</script>`).toString('base64')
    }
  }
})
const evaluate = async (context, expression) => {
  const reply = await browser.send('Runtime.evaluate', {
    expression, contextId: context.id, awaitPromise: true, returnByValue: true
  }, context.sessionId)
  if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails))
  return reply.result.value
}
async function tabs (previous = new Set()) {
  return browser.until(() => {
    const contexts = [...browser.contexts.values()].filter(c => c.origin === origin && c.auxData?.isDefault && !previous.has(c.uniqueId))
    return contexts.length === 2 && contexts
  }, 'two independent same-origin tabs')
}
try {
  await browser.navigate(origin + '/__tests__/quotas/one')
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const second = await browser.until(() => [...browser.contexts.values()].find(c => c.auxData?.frameId === targetId && c.auxData?.isDefault), 'second page attached')
  await browser.send('Page.navigate', { url: origin + '/__tests__/quotas/two' }, second.sessionId)
  let contexts = await tabs()
  await browser.until(async () => (await Promise.all(contexts.map(c => evaluate(c, '!!globalThis.fixture')))).every(Boolean), 'fixture modules')
  const info = await Promise.all(contexts.map((c, i) => evaluate(c, `fixture.setup(${20 + i})`)))
  await evaluate(contexts[0], `fixture.setNostrDbQuotaLimits({ publicBytes: ${info[0].bytes} })`)
  await evaluate(contexts[0], 'void navigator.locks.request(fixture.QUOTA_LOCK, () => new Promise(resolve => { globalThis.releaseQuotaLock = resolve }))')
  await browser.until(() => evaluate(contexts[0], '!!globalThis.releaseQuotaLock'), 'quota barrier')
  const admissions = contexts.map(c => evaluate(c, 'fixture.db.add(fixture.event)'))
  await browser.until(() => evaluate(contexts[0], 'navigator.locks.query().then(state => state.pending.filter(lock => lock.name === fixture.QUOTA_LOCK).length >= 2)'), 'both tabs waiting on global quota')
  await evaluate(contexts[0], 'releaseQuotaLock()')
  const results = await Promise.all(admissions)
  assert.equal(results.filter(r => r.stored).length, 1)
  assert.equal(results.filter(r => r.quotaCategory === 'public').length, 1)
  assert.equal((await evaluate(contexts[1], 'fixture.getNostrDbQuotaUsage()')).publicBytes, info[0].bytes)

  // Reload without restoring any data and read the persisted global summaries.
  const previous = new Set(contexts.map(c => c.uniqueId))
  await Promise.all(contexts.map(c => browser.send('Page.reload', {}, c.sessionId)))
  contexts = await tabs(previous)
  await browser.until(async () => (await Promise.all(contexts.map(c => evaluate(c, '!!globalThis.fixture')))).every(Boolean), 'reloaded modules')
  assert.equal((await evaluate(contexts[0], 'fixture.getNostrDbQuotaUsage()')).publicCount, 1)
  const winner = info[results.findIndex(r => r.stored)].owner
  await evaluate(contexts[1], `fixture.openNostrDb('${winner}').then(() => true)`)
  assert.equal(await evaluate(contexts[0], `fixture.deleteNostrDb('${winner}')`), true)
  assert.equal((await evaluate(contexts[1], 'fixture.getNostrDbQuotaUsage()')).publicBytes, 0)
  console.log('NostrDB quotas: concurrent tabs, reload and cross-tab owner removal passed')
} finally {
  await browser.diagnose('/tmp/44billion-nostrdb-quota-browser')
  await browser.close()
}
