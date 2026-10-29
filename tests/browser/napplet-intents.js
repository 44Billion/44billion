import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build, stop } from 'esbuild'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { launchChrome } from './runtime/chrome.js'
import { nappletDescriptor, nappletReference } from '../../src/helpers/napplet.js'

const artifacts = new Map()
function app (name, html, tags = []) {
  const bytes = new TextEncoder().encode(html)
  const hash = bytesToHex(sha256(bytes))
  artifacts.set(`https://intent-fixture.example/${hash}`, bytes)
  const event = finalizeEvent({ kind: 35129, created_at: 1, content: 'Intent browser fixture', tags: [['d', name], ['title', name], ['x', hash], ['server', 'https://intent-fixture.example'], ...tags] }, generateSecretKey())
  return { event, bytes, appId: nappletDescriptor(event).appId, reference: nappletReference(event) }
}
const targetHtml = name => `<!doctype html><html><head></head><body><p>${name}</p><script>
  parent.postMessage({intentBoot:${JSON.stringify(name)}},'*');
  setTimeout(()=>window.napplet.intent.onDelivery(delivery=>parent.postMessage({intentDelivery:delivery,target:${JSON.stringify(name)}},'*')),150);
</script></body></html>`
const profile = app('Profile handler', targetHtml('profile'), [['z', 'profile'], ['i', 'napplet:profile/open', 'pubkey']])
const alternative = app('Other profile handler', targetHtml('other'), [['z', 'profile'], ['i', 'napplet:profile/open', 'pubkey']])
const remote = app('Message handler', targetHtml('dm'), [['z', 'dm'], ['i', 'napplet:dm/open', 'pubkey']])
const source = app('Source', `<!doctype html><html><head></head><body><a id='link' href='napplet:profile/open?pubkey=anchor%2Bvalue'>Open profile</a><script>
  addEventListener('message',event=>{
    if(event.source!==parent)return;
    if(event.data.intentPing)parent.postMessage({intentPong:true},'*');
    if(event.data.clickIntent)document.getElementById('link').click();
    if(event.data.invokeIntent) {
      try { window.napplet.intent.open(event.data.invokeIntent,event.data.options).then(result=>parent.postMessage({intentResult:result},'*'),error=>parent.postMessage({intentError:String(error)},'*')); }
      catch(error){parent.postMessage({intentError:String(error)},'*')}
    }
  });
  parent.postMessage({sourceBoot:true,compatMode:document.compatMode},'*');
</script></body></html>`)
const stubs = {
  '#zones/vault-modal/index.js': 'export const useVaultActor=()=>({askVault(){throw new Error("Unexpected vault call")}});export const useVaultModalStore=()=>({});export const tellVault=()=>{};export const flushQueuedVaultAcceptedMessages=async()=>{}',
  '#zones/permission-dialog/index.js': 'export const permissionDialogLocales={};export const usePermissionDialogStore=()=>({requestPermission(){throw new Error("Unexpected permission request")},clearApp(){}})',
  '#zones/confirmation-dialog/index.js': 'export const useConfirmationDialogStore=()=>({requestConfirmation(){throw new Error("Unexpected confirmation")}})'
}
let browser
const server = createServer()
try {
  const bundle = await build({
    entryPoints: { fixture: 'tests/browser/napplets-fixture.js' }, bundle: true, write: false, format: 'esm', splitting: true, outdir: '/tmp/44b-intent-browser',
    define: { IS_DEVELOPMENT: 'false' }, loader: { '.css': 'text', '.svg': 'text', '.png': 'dataurl', '.webp': 'dataurl' },
    plugins: [{
      name: 'host-stubs', setup (builder) {
        builder.onResolve({ filter: /^#zones\/(vault-modal|permission-dialog|confirmation-dialog)\/index\.js$/ }, args => ({ path: args.path, namespace: 'stub' }))
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
      }
    }]
  })
  const outputs = new Map(bundle.outputFiles.map(file => [`/${file.path.split('/').pop()}`, file.contents]))
  server.on('request', (request, response) => {
    if (outputs.has(request.url)) { response.setHeader('Content-Type', 'text/javascript'); response.end(outputs.get(request.url)); return }
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><html><body><script>window.catalogEvents=${JSON.stringify([remote.event, alternative.event])};window.catalogProfiles=[];</script><script type='module' src='/fixture.js'></script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://localhost:${server.address().port}`
  browser = await launchChrome({ intercept: request => artifacts.has(request.url) ? { responseCode: 200, responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(artifacts.get(request.url)).toString('base64') } : null })
  const evaluate = expression => browser.evaluate(expression, origin)
  const act = expression => evaluate(`(async()=>{${expression}})()`)
  await browser.navigate(origin)
  await browser.until(() => evaluate('!!window.fixture?.appRouter'), 'intent host')
  await evaluate('window.deliveries=[];window.results=[];window.intentErrors=[];window.boots=[];addEventListener(\'message\',event=>{if(event.data?.sourceBoot){window.sourceFrame=event.source;window.sourceCompat=event.data.compatMode;}if(event.data?.intentPong)window.sourceResponsive=true;if(event.data?.intentDelivery)deliveries.push(event.data);if(event.data?.intentResult)results.push(event.data.intentResult);if(event.data?.intentError)intentErrors.push(event.data.intentError);if(event.data?.intentBoot)boots.push(event.data.intentBoot)});')
  const install = async entry => act(`await fixture.installNapplet(${JSON.stringify(entry.event)},{fetchBlob:async()=>new Uint8Array(${JSON.stringify([...entry.bytes])})});await fixture.appRouter.openApp('/napplet/${entry.reference}')`)
  await install(profile)
  await browser.until(() => evaluate('boots.includes("profile")'), 'initial profile')
  await evaluate('fixture.close(fixture.tabStorage.session_workspaceByKey_ws_openAppKeys$()[0])')
  await install(source)
  await browser.until(() => evaluate('!!window.sourceFrame'), 'source namespace ready')
  assert.equal(await evaluate('sourceCompat'), 'CSS1Compat')
  await evaluate('sourceFrame.postMessage({clickIntent:true},"*")')
  await browser.until(() => evaluate('deliveries.length===1'), 'cold handler from intent anchor')
  assert.equal(await evaluate('deliveries[0].intentDelivery.payload.pubkey'), 'anchor+value')
  assert.equal(await evaluate('deliveries[0].intentDelivery.sender'), nappletDescriptor(source.event).catalogId)
  assert.equal(await evaluate('boots.filter(name=>name==="profile").length'), 2)
  await evaluate('sourceFrame.postMessage({invokeIntent:"napplet:profile/open",options:{payload:{pubkey:"reuse"}}},"*")')
  await browser.until(() => evaluate('deliveries.length===2 && results.length===1'), 'reuse delivery and acceptance')
  assert.equal(await evaluate('results[0].ok'), true)
  assert.equal(await evaluate('boots.filter(name=>name==="profile").length'), 2)
  await evaluate('sourceFrame.postMessage({invokeIntent:"napplet:profile/open",options:{payload:{pubkey:"new"},behavior:{reuse:false}}},"*")')
  await browser.until(() => evaluate('deliveries.length===3 && results.length===2'), 'new window delivery')
  assert.equal(await evaluate('boots.filter(name=>name==="profile").length'), 3)
  await install(alternative)
  await browser.until(() => evaluate('boots.includes("other")'), 'second handler')
  await evaluate('sourceFrame.postMessage({invokeIntent:"napplet:profile/open",options:{handler:"choose",payload:{pubkey:"choice"}}},"*")')
  await browser.until(() => evaluate('!!document.querySelector("napplet-host-ui dialog[open]")'), 'handler chooser')
  assert.equal(await evaluate('document.querySelectorAll("napplet-host-ui dialog[open] p button").length'), 2)
  await evaluate('const dialog=document.querySelector("napplet-host-ui dialog[open]");dialog.querySelector("input").click();dialog.querySelector("p button").click()')
  await browser.until(() => evaluate('deliveries.length===4 && results.length===3'), 'chosen delivery')
  assert.equal(await evaluate('!!JSON.parse(localStorage.local_nappletIntentDefaults).alice.profile'), true)
  await evaluate('sourceFrame.postMessage({invokeIntent:"napplet:profile/open",options:{handler:"choose"}},"*")')
  await browser.until(() => evaluate('!!document.querySelector("napplet-host-ui dialog[open]")'), 'second chooser')
  await evaluate(`fixture.close(fixture.storage['session_workspaceByKey_ws_appById_${source.appId}_appKeys$']()[0]);window.sourceFrame=null`)
  await browser.until(() => evaluate('!document.querySelector("napplet-host-ui dialog[open]")'), 'source closure cancels chooser')
  await act(`await fixture.appRouter.openApp('/napplet/${source.reference}')`)
  await browser.until(() => evaluate('!!sourceFrame'), 'source reopened')
  await evaluate('sourceFrame.postMessage({invokeIntent:"napplet:dm/open?pubkey=store%2Bpayload"},"*")')
  await browser.until(() => evaluate('results.length===4 && !!document.querySelector("napplet-catalog")'), 'no-handler store')
  assert.deepEqual(await evaluate('results[3]'), { ok: false, error: 'no handler' })
  await browser.until(() => evaluate('document.querySelectorAll("napplet-catalog article").length===1 && document.querySelector("napplet-catalog article h2").textContent==="Message handler"'), 'exact store filter')
  // Repeated missing-handler intents must keep the store's instance key,
  // including while it is minimized or closed, and refresh its filter.
  const storeKeyExpression = 'fixture.storage["session_workspaceByKey_ws_appById_builtin-napplet-store_appKeys$"]()'
  const storeKey = await evaluate(`${storeKeyExpression}[0]`)
  let resultCount = 4
  for (const visibility of ['open', 'minimized', 'closed']) {
    await evaluate(`window.previousStoreElement=document.querySelector('napplet-catalog');fixture.tabStorage['session_appByKey_${storeKey}_visibility$'](${JSON.stringify(visibility)});fixture.tabStorage.session_workspaceByKey_ws_openAppKeys$((value=[])=>{const other=value.filter(key=>key!==${JSON.stringify(storeKey)});return ${JSON.stringify(visibility)}==='closed'?other:value})`)
    await act('await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    if (visibility === 'closed') await browser.until(() => evaluate('!document.querySelector("napplet-catalog")'), 'closed store unmounted')
    await evaluate('window.sourceResponsive=false')
    await browser.until(() => evaluate('sourceFrame.postMessage({intentPing:true},"*");sourceResponsive'), 'source ready after window ordering')
    const uri = visibility === 'minimized' ? 'napplet:missing/open' : 'napplet:dm/open?pubkey=store%2Bpayload'
    await evaluate(`sourceFrame.postMessage({invokeIntent:${JSON.stringify(uri)}},"*")`)
    resultCount++
    await browser.until(() => evaluate(`results.length===${resultCount} && fixture.tabStorage.session_workspaceByKey_ws_openAppKeys$()[0]===${JSON.stringify(storeKey)}`), `reuse ${visibility} store`)
    assert.deepEqual(await evaluate(storeKeyExpression), [storeKey])
    if (visibility !== 'closed') assert.equal(await evaluate('document.querySelector("napplet-catalog")===previousStoreElement'), true)
    assert.equal(await evaluate(`fixture.tabStorage['session_appByKey_${storeKey}_visibility$']()`), 'open')
    await browser.until(() => evaluate(`document.querySelector("napplet-catalog strong")?.textContent===${JSON.stringify(uri.split('?')[0])}`), 'updated store convention')
    if (visibility === 'minimized') await browser.until(() => evaluate('document.querySelectorAll("napplet-catalog article").length===0'), 'different convention clears results')
  }
  await browser.until(() => evaluate('document.querySelectorAll("napplet-catalog article").length===1'), 'restored message handler filter')
  assert.equal(await evaluate('document.querySelector("napplet-catalog article button").textContent'), 'Install and continue')
  await evaluate('document.querySelector("napplet-catalog article button").click()')
  await browser.until(() => evaluate('deliveries.length===5'), 'installed store continuation')
  assert.equal(await evaluate('deliveries[4].intentDelivery.payload.pubkey'), 'store+payload')
  assert.equal(await evaluate('deliveries[4].target'), 'dm')
  assert.deepEqual(await evaluate('intentErrors'), [])
  console.log('Intent browser checks passed: anchor links, cold startup, buffered delivery, reuse/new windows, chooser/default, exact store discovery, install and continue.')
} catch (error) {
  await browser?.diagnose(new URL('../../tmp/napplet-intents-browser', import.meta.url).pathname)
  throw error
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  stop()
}
