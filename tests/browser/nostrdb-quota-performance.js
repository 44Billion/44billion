// Optional baseline JSON maps source paths to their previous contents. Source
// overlays are build-only; neither working tree nor dependencies are replaced.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launchChrome } from './runtime/chrome.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const baseline = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : null
const reports = {}
for (const [name, overlay] of [...(baseline ? [['baseline', baseline]] : []), ['current', null]]) {
  const bundle = await build({
    absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'esm',
    define: { IS_DEVELOPMENT: 'true', IS_PRODUCTION: 'false' },
    plugins: overlay
      ? [{
          name: 'baseline', setup (builder) {
            builder.onLoad({ filter: /\/nostrdb\/(index|quotas)\.js$/ }, args => {
              const contents = overlay[args.path.slice(root.length)]
              return contents ? { contents, loader: 'js' } : undefined
            })
          }
        }]
      : [],
    stdin: {
      resolveDir: root, contents: `
      import {getNostrDb,openNostrDb,toStoredRecord,eventIdIndexKey} from './src/services/idb/nostrdb/index.js';
      import * as quotas from './src/services/idb/nostrdb/quotas.js';
      import {finalizeEvent} from 'libp2r2p/event';
      import {getPublicKey} from 'libp2r2p/key';
      import {buildPersonalCopyUnsignedEvent} from './src/helpers/personal-copy.js';
      console.debug=()=>{};
      const request = req => new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
      const percentile = (values,p) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
      globalThis.run = async () => {
        const accounts=[];
        for(let n=0;n<3;n++) {
          const secret=new Uint8Array(32).fill(60+n), owner=getPublicKey(secret);
          const db=getNostrDb(owner,{maintenance:false}), raw=await openNostrDb(owner);
          db.personalCopyDecrypt=async event=>event.content;
          db.personalCopyObfuscate=async(value,kind,scope)=>scope+':'+value;
          const template=finalizeEvent({kind:1006,created_at:1,tags:[['k','30078'],['c','recovery']],content:'x'.repeat(512)},secret);
          const tx=raw.transaction(['events','maintenance'],'readwrite');
          const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
          const usage=quotas.initialQuotaUsage(true);
          for(let i=0;i<5000;i++) {
            const event={...template,id:(i+1).toString(16).padStart(64,'0')};
            const row=toStoredRecord(event);row.eventBytes=new TextEncoder().encode(JSON.stringify(event)).length;row.ownerRefs=[];
            tx.objectStore('events').put(row);usage.privateBytes+=row.eventBytes;usage.privateCount++;
          }
          tx.objectStore('maintenance').put(usage);await done;
          const copies=[];
          for(let i=0;i<40;i++) copies.push(finalizeEvent(await buildPersonalCopyUnsignedEvent({
            originalEvent:{kind:9,created_at:100+i,tags:[],content:'message '+i},ownerPubkey:owner,context:'chat',
            encrypt:async(kind,value)=>value,obfuscate:db.personalCopyObfuscate
          }),secret));
          accounts.push({db,raw,secret,copies});
        }
        await quotas.getNostrDbQuotaUsage();
        const original=indexedDB.databases.bind(indexedDB);let enumerations=0;
        indexedDB.databases=()=>{enumerations++;return original()};
        const result={};let position=0;
        for(const scenario of ['idle','history','profiles']) {
          const profiles=[];
          if(scenario==='profiles')for(let i=0;i<100;i++)profiles.push(finalizeEvent({kind:0,created_at:200+i,tags:[],content:'{}'},new Uint8Array(32).fill(90+i)));
          const background=scenario==='history'
            ? Array.from({length:25},(_,i)=>accounts[i%3].db.query({kinds:[1006], '#k':['30078'],limit:50}))
            : profiles.map((event,i)=>accounts[i%3].db.add(event));
          const values=[],lockWait=[],execution=[];const before=enumerations;
          for(let i=0;i<12;i++) {
            const event=accounts[0].copies[position++];const start=performance.now();
            const stored=await accounts[0].db.add(event,{onTiming:entry=>{
              if(entry.stage==='quota-lock-wait')lockWait.push(entry.elapsedMs);
              if(entry.stage==='quota-lock-execution'||entry.stage==='quota-mutation')execution.push(entry.elapsedMs);
            }});
            if(!stored.stored)throw new Error('message not stored: '+stored.code);
            values.push(performance.now()-start);
          }
          await Promise.all(background);
          result[scenario]={samples:values.length,medianMs:percentile(values,.5),p95Ms:percentile(values,.95),
            enumerations:enumerations-before,quotaWaitMedianMs:lockWait.length?percentile(lockWait,.5):0,
            quotaWorkMedianMs:percentile(execution,.5)};
        }
        indexedDB.databases=original;
        for(const account of accounts) {
          const usage=await request(account.raw.transaction('maintenance').objectStore('maintenance').get('quotaUsage'));
          if(usage.privateCount!==(account===accounts[0]?5036:5000))throw new Error('incorrect local counter');
        }
        return result;
      };
    `
    }
  })
  const browser = await launchChrome({
    intercept: request => request.url.startsWith('http://localhost:10000/')
      ? {
          responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
          body: Buffer.from(`<script type="module">${bundle.outputFiles[0].text}</script>`).toString('base64')
        }
      : null
  })
  try {
    await browser.navigate('http://localhost:10000/__tests__/quota-performance')
    const context = await browser.until(() => [...browser.contexts.values()].find(c => c.origin === 'http://localhost:10000' && c.auxData?.isDefault), 'fixture context')
    const evaluate = async expression => {
      const response = await browser.send('Runtime.evaluate', { expression, contextId: context.id, awaitPromise: true, returnByValue: true }, context.sessionId)
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
      return response.result.value
    }
    await browser.until(() => evaluate('typeof run === "function"'), 'benchmark ready')
    reports[name] = await evaluate('run()')
    if (name === 'current') for (const scenario of Object.values(reports[name])) assert.equal(scenario.enumerations, 0)
    console.log(JSON.stringify({ name, scenarios: reports[name] }))
  } finally {
    await browser.diagnose(`/tmp/44billion-quota-performance-${name}`)
    await browser.close()
  }
}
await writeFile('/tmp/44billion-quota-performance.json', JSON.stringify(reports, null, 2))
