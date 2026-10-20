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
    quotas.startGlobalQuotaMaintenance();
    globalThis.fixture = {
      ...quotas, deleteNostrDb, openNostrDb,
      async preparePromotion(seed) {
        await this.setup(seed);
        this.target = finalizeEvent({kind:1,created_at:124,tags:[],content:'x'.repeat(3000)}, new Uint8Array(32).fill(3));
        await this.db.add(this.target);
        this.ref = finalizeEvent({kind:1,created_at:125,tags:[['q',this.target.id]],content:''}, new Uint8Array(32).fill(seed));
        return {refBytes:new TextEncoder().encode(JSON.stringify(this.ref)).length,targetBytes:new TextEncoder().encode(JSON.stringify(this.target)).length};
      },
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
  const results = await Promise.all(contexts.map(c => evaluate(c, 'fixture.db.add(fixture.event)')))
  assert.equal(results.filter(r => r.stored).length, 2, 'admissions finish while maintenance lock is held')
  const removal = await evaluate(contexts[0], "fixture.db.remove([['e', fixture.event.id]])")
  assert.equal(removal.deleted, 1, 'removal also bypasses maintenance')
  assert.equal((await evaluate(contexts[0], 'fixture.db.add(fixture.event)')).stored, true)
  await evaluate(contexts[0], 'releaseQuotaLock()')
  assert.equal((await evaluate(contexts[0], 'fixture.getNostrDbQuotaUsage()')).publicCount, 2)
  await browser.until(() => evaluate(contexts[1], 'fixture.readQuotaState()?.blocked.public === true'), 'quota revision reached other tab')
  assert.equal((await evaluate(contexts[1], "fixture.db.add({...fixture.event, id:'bad'})")).code, 'invalid')
  assert.equal((await evaluate(contexts[1], "fixture.db.remove([['e',fixture.event.id]],{assertAccess(){throw Object.assign(new Error('revoked'),{code:'PUBKEY_NOT_IN_PERSONA'})}}).catch(e=>({code:e.code}))")).code, 'PUBKEY_NOT_IN_PERSONA')
  // Reload without restoring data. Both the events and growth gates survive.
  const previous = new Set(contexts.map(c => c.uniqueId))
  await Promise.all(contexts.map(c => browser.send('Page.reload', {}, c.sessionId)))
  contexts = await tabs(previous)
  await browser.until(async () => (await Promise.all(contexts.map(c => evaluate(c, '!!globalThis.fixture')))).every(Boolean), 'reloaded modules')
  assert.equal((await evaluate(contexts[0], 'fixture.getNostrDbQuotaUsage()')).publicCount, 2)
  assert.equal(await evaluate(contexts[1], 'fixture.readQuotaState().blocked.public'), true)
  for (const { owner } of info) {
    await evaluate(contexts[1], `fixture.openNostrDb('${owner}').then(() => true)`)
    assert.equal(await evaluate(contexts[0], `fixture.deleteNostrDb('${owner}')`), true)
  }
  assert.equal((await evaluate(contexts[1], 'fixture.getNostrDbQuotaUsage()')).publicCount, 0)
  await evaluate(contexts[0], 'fixture.setNostrDbQuotaLimits({publicBytes:536870912})')
  const promotions = await Promise.all(contexts.map((c, i) => evaluate(c, `fixture.preparePromotion(${30 + i})`)))
  const promotionBudget = promotions[0].refBytes + promotions[1].refBytes + promotions[0].targetBytes
  await evaluate(contexts[0], `fixture.setNostrDbQuotaLimits({publicBytes:${promotionBudget}})`)
  await evaluate(contexts[0], 'void navigator.locks.request(fixture.QUOTA_LOCK, () => new Promise(resolve => { globalThis.releasePromotionLock = resolve }))')
  await browser.until(() => evaluate(contexts[0], '!!globalThis.releasePromotionLock'), 'promotion barrier')
  const promoted = await Promise.all(contexts.map(c => evaluate(c, 'fixture.db.add(fixture.ref)')))
  assert.ok(promoted.every(r => r.stored))
  await evaluate(contexts[0], 'releasePromotionLock()')
  const promotedUsage = await evaluate(contexts[0], 'fixture.getNostrDbQuotaUsage()')
  assert.ok(promotedUsage.publicBytes > promotionBudget)
  assert.equal(promotedUsage.publicCount, 4)
  assert.equal(promotedUsage.cacheCount, 0)
  const targetCounts = await Promise.all(contexts.map(c => evaluate(c, 'fixture.db.count({ids:[fixture.target.id]})')))
  assert.equal(targetCounts.reduce((sum, n) => sum + n, 0), 2, 'protected targets survive overshoot')
  await evaluate(contexts[0], 'fixture.setNostrDbQuotaLimits({publicBytes:536870912});')
  // A cache-only transaction must finish even while another tab owns the global
  // quota lock. Timestamp metadata must not recreate a replacement database.
  await evaluate(contexts[0], 'fixture.preparePromotion(40)')
  await evaluate(contexts[0], `(async()=>{fixture.raw = await fixture.openNostrDb(fixture.owner); await new Promise((resolve,reject) => {
    const tx=fixture.raw.transaction('cacheAccess','readwrite'); tx.objectStore('cacheAccess').openCursor().onsuccess=e=>{const c=e.target.result;if(c){c.update({...c.value,lastAccessAt:1});c.continue()}};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  })})()`)
  await evaluate(contexts[1], 'void navigator.locks.request(fixture.QUOTA_LOCK, () => new Promise(resolve => { globalThis.releaseTouchLock = resolve }))')
  await browser.until(() => evaluate(contexts[1], '!!releaseTouchLock'), 'cross-tab touch barrier')
  await evaluate(contexts[0], 'fixture.queueCacheAccess(fixture.owner,[fixture.target]); fixture.flushCacheAccess()')
  assert.ok(await evaluate(contexts[0], 'new Promise((resolve,reject)=>{const req=fixture.raw.transaction(\'cacheAccess\').objectStore(\'cacheAccess\').getAll();req.onsuccess=()=>resolve(req.result.some(row=>row.lastAccessAt>1));req.onerror=()=>reject(req.error)})'))
  await evaluate(contexts[1], 'releaseTouchLock()')
  console.log('NostrDB quotas: foreground admission/removal during maintenance, advisory gates, cross-tab protected promotions, touches, reload and owner removal passed')
} finally {
  await browser.diagnose('/tmp/44billion-nostrdb-quota-browser')
  await browser.close()
}
