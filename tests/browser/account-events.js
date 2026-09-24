// Real IndexedDB + published RelayPool; controlled transport and disposable origin.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { launchChrome } from './runtime/chrome.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, format: 'esm', platform: 'browser',
  define: { IS_DEVELOPMENT: 'false', IS_PRODUCTION: 'true' },
  stdin: {
    resolveDir: root, contents: `
    import { createAccountEventTracker, accountKinds } from './src/services/account-events.js';
    import { createAccountEventCoverage } from './src/services/account-event-coverage.js';
    import { getNostrDb } from './src/services/idb/nostrdb/index.js';
    import { accountRelayFixture } from './tests/fixtures/account-relay.js';
    import { finalizeEvent } from 'libp2r2p/event';
    import { getPublicKey } from 'libp2r2p/key';
    const baseline = Number(localStorage.fixtureAccountTime) || Math.floor(Date.now()/1000);
    localStorage.fixtureAccountTime = baseline;
    const relay = 'wss://relay.example';
    const events = [];
    const accounts = [];
    const errors = [];
    const warnings = [];
    for (let index = 1; index <= 6; index++) {
      const secret = new Uint8Array(32).fill(index);
      const pubkey = getPublicKey(secret);
      const metadata = finalizeEvent({kind:10002, created_at:baseline-2000,tags:[['r',relay]],content:''},secret);
      for(let n=0;n<(index===1?240:3);n++) events.push(finalizeEvent({kind:1,created_at:baseline-1000,tags:[],content:String(n)},secret));
      const db = getNostrDb(pubkey,{maintenance:false});
      const coverage = createAccountEventCoverage(pubkey);
      accounts.push({pubkey,db,coverage,isReadOnly:index===6,getStoredEvent:kind=>kind===10002?metadata:null,sendToVault:()=>{}});
    }
    const transport = accountRelayFixture({events});
    const controller = new AbortController();
    const tracker = createAccountEventTracker({pool:transport.pool,seeds:[relay],signal:controller.signal,reportError:(error,context)=>errors.push({message:error.message,...context}),warn:(...args)=>warnings.push(args)});
    globalThis.fixture = {
      baseline, accounts, transport, tracker, errors, warnings,
      start:()=>tracker.setAccounts(accounts),
      stop:async()=>{controller.abort();await tracker.settled();await transport.pool.disconnectAll()},
      complete:async()=>{
        for(const account of accounts) {
          const rows=await account.coverage.read(relay,accountKinds);
          if(!rows.every(row=>row.intervals[0]?.[0]===0&&row.intervals[0]?.[1]>=baseline))return false;
        }
        return true;
      },
      counts:()=>Promise.all(accounts.map(account=>account.db.count([{kinds:[1],authors:[account.pubkey]}]))),
      isolated:async()=>{
        for(const account of accounts) {
          const {results}=await account.db.query({kinds:[1]});
          if(results.some(event=>event.pubkey!==account.pubkey))return false;
        }
        return true;
      }
    };
  `
  }
})
const script = bundle.outputFiles[0].text
const origin = 'http://localhost:10000'
const browser = await launchChrome({
  intercept: request => request.url.startsWith(origin + '/')
    ? {
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: request.url.endsWith('/fixture.js') ? 'text/javascript' : 'text/html' }],
        body: Buffer.from(request.url.endsWith('/fixture.js') ? script : '<!doctype html><script type="module" src="/fixture.js"></script>').toString('base64')
      }
    : null
})
let context
async function evaluate (expression) {
  const result = await browser.send('Runtime.evaluate', { expression, contextId: context.id, awaitPromise: true, returnByValue: true }, context.sessionId)
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function ready () {
  context = await browser.until(() => [...browser.contexts.values()].find(value => value.origin === origin && value.auxData?.isDefault), 'account fixture context')
  await browser.until(() => evaluate('!!globalThis.fixture'), 'account fixture setup')
}
try {
  await browser.navigate(origin)
  await ready()
  await evaluate('fixture.start()')
  await browser.until(() => evaluate('fixture.complete()'), 'durable account history')
  assert.deepEqual(await evaluate('fixture.errors'), [])
  assert.deepEqual(await evaluate('fixture.counts()'), [200, 3, 3, 3, 3, 3])
  assert.equal(await evaluate('fixture.isolated()'), true)
  assert.equal(await evaluate('fixture.transport.subscriptions.filter(sub=>!sub.closed&&sub.filter.limit===0).length'), 4)
  assert.equal(await evaluate('fixture.warnings.length'), 1)
  await evaluate('fixture.stop()')
  assert.equal(await evaluate('fixture.transport.subscriptions.filter(sub=>!sub.closed).length'), 0)

  await browser.send('Page.reload', {}, context.sessionId)
  await browser.until(() => ![...browser.contexts.values()].some(value => value.id === context.id && value.sessionId === context.sessionId), 'old account context gone')
  await ready()
  await evaluate('fixture.start()')
  await browser.until(() => evaluate('fixture.transport.calls.length>=4'), 'reloaded recent feeds')
  await browser.until(() => evaluate('fixture.complete()'), 'reloaded coverage')
  // Let startup scheduling settle; any accidental full-history query is visible.
  await evaluate('new Promise(resolve=>setTimeout(resolve,200))')
  assert.equal(await evaluate('fixture.transport.calls.every(call=>call.filter.since>=fixture.baseline-620)'), true)
  assert.deepEqual(await evaluate('fixture.counts()'), [200, 3, 3, 3, 3, 3])
  assert.deepEqual(await evaluate('fixture.errors'), [])
  await evaluate('fixture.tracker.setAccounts([fixture.accounts[0]])')
  await browser.until(() => evaluate('fixture.transport.subscriptions.filter(sub=>!sub.closed).length===4 && fixture.transport.subscriptions.filter(sub=>!sub.closed).every(sub=>sub.filter.authors.length===1)'), 'regrouped account feeds')
  await evaluate('fixture.stop()')
  console.log('Account ingestion: grouped feeds, owner isolation, saturation, real IDB checkpoints, reload and cancellation passed.')
} catch (error) {
  console.error('Account diagnostics:', await evaluate('({errors:fixture.errors,calls:fixture.transport.calls.slice(-8),warnings:fixture.warnings})').catch(() => null))
  throw error
} finally { await browser.close() }
