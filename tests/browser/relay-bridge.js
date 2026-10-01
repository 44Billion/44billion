// Real launcher/app/vault ports; only the upstream WebSocket is controlled.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { ensureRuntime } from '../../bin/dev-runtime.js'
import { launchChrome } from './runtime/chrome.js'
import { prepareTestApp } from './runtime/prepare-app.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const runtime = await ensureRuntime({ log: () => {} })
let browser
try {
  const app = await prepareTestApp([{ name: 'index.html', bytes: new TextEncoder().encode('<!doctype html><title>Relay bridge regression</title><p>Relay bridge regression</p>') }], { identifier: 'relay-bridge-regression', name: 'Relay bridge regression' })
  browser = await launchChrome()
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
    if (location.hostname === 'localhost' && location.port === '10000') {
      window.transport = { opened: 0, closed: 0, frames: [] };
      window.WebSocket = class extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
        readyState = 0; bufferedAmount = 0; extensions = ''; protocol = '';
        constructor(url) { super(); this.url = url; transport.opened++; setTimeout(() => { this.readyState = 1; this.onopen?.({}); this.dispatchEvent(new Event('open')); }, 0); }
        send(raw) {
          const [op, id, filter] = JSON.parse(raw);
          transport.frames.push({op,id,marker:filter?.['#t']?.[0],at:performance.now()});
          if (op !== 'REQ') return;
          if(filter.kinds?.includes(9701)) {
            setTimeout(() => { const data=JSON.stringify(['CLOSED',id,'rate-limited: test',{retry_after:1}]); this.onmessage?.({data}); this.dispatchEvent(new MessageEvent('message',{data})); },0);
            return;
          }
          const size = filter.kinds?.includes(9700) ? (filter['#t']?.[0] === 'large' ? 2*1024*1024 : filter['#t']?.[0] === 'oversize' ? 5*1024*1024 : 17*1024) : 0;
          const count = size === 17*1024 ? 82 : size ? 1 : 0;
          setTimeout(() => {
            for(let index=0; index<count; index++) {
              const data = JSON.stringify(['EVENT', id, { id:index.toString(16).padStart(64,'0'), pubkey:'a'.repeat(64), sig:'b'.repeat(128), kind:9700, created_at:index, tags:[], content:'x'.repeat(size) }]);
              this.onmessage?.({data}); this.dispatchEvent(new MessageEvent('message',{data}));
            }
            const data = JSON.stringify(['EOSE',id]); this.onmessage?.({data}); this.dispatchEvent(new MessageEvent('message',{data}));
          }, 0);
        }
        close() { this.readyState=3; transport.closed++; this.onclose?.({code:1000,reason:'',wasClean:true}); }
      };
    }
  `
  }, browser.sessionId)
  await browser.navigate('http://localhost:10000')
  await browser.until(() => browser.evaluate('Boolean(localStorage.getItem("session_workspaceKeys"))'), 'launcher ready')
  const vault = 'http://localhost:4000'
  await browser.until(() => browser.evaluate('WebSocket.name === "LauncherRelayPoolWebSocket"', vault), 'real delegated vault socket')
  await browser.evaluate(app.installExpression)
  await browser.navigate(`http://localhost:10000/${app.app}`)
  const url = await browser.until(() => browser.evaluate('[...document.querySelectorAll("app-window iframe")].map(frame => frame.src).find(src => src.startsWith("http:") && /^[0-9]+[.]localhost$/.test(new URL(src).hostname))'), 'app frame')
  const appOrigin = new URL(url).origin
  await browser.until(() => browser.evaluate('WebSocket.name === "LauncherRelayPoolWebSocket"', vault), 'vault after navigation')
  for (const origin of [vault, appOrigin]) {
    await browser.evaluate(`(() => {
      window.bridgeTest = { frames:[], credits:[], closes:[], sockets:[] };
      const post = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function(message,...rest) {
        if(message?.code==='RELAY_CREDIT') { bridgeTest.credits.push({...message.payload}); if(bridgeTest.credits.length>32)bridgeTest.credits.shift(); }
        return post.call(this,message,...rest);
      };
      bridgeTest.open = async () => {
        const socket = new WebSocket('wss://nos.lol'); bridgeTest.sockets.push(socket);
        socket.onclose = event => bridgeTest.closes.push({code:event.code,reason:event.reason});
        socket.onmessage = event => {
          const [op,id,value] = JSON.parse(event.data);
          // Block this consumer briefly while the launcher can continue receiving.
          if(op==='EVENT' && bridgeTest.frames.length===0) { const until=performance.now()+100; while(performance.now()<until){} }
          bridgeTest.frames.push({op,id,index:value?.created_at,size:value?.content?.length});
        };
        await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;}); return bridgeTest.sockets.length-1;
      };
    })()`, origin)
    await browser.evaluate('bridgeTest.open()', origin)
    for (const mode of ['burst', 'burst', 'large']) {
      await browser.evaluate(`bridgeTest.frames=[]; bridgeTest.sockets[0].send(JSON.stringify(['REQ','same-id',{kinds:[9700],'#t':[${JSON.stringify(mode)}]}]))`, origin)
      await browser.until(() => browser.evaluate('bridgeTest.frames.at(-1)?.op === "EOSE"', origin), `${origin} ${mode} EOSE`)
      const frames = await browser.evaluate('bridgeTest.frames', origin)
      assert.equal(frames.length, mode === 'large' ? 2 : 83)
      assert.deepEqual(frames.slice(0, -1).map(frame => frame.index), Array.from({ length: frames.length - 1 }, (_, index) => index))
      assert.deepEqual(await browser.evaluate('bridgeTest.closes', origin), [])
    }
    await browser.evaluate('bridgeTest.frames=[]; bridgeTest.sockets[0].send(JSON.stringify([\'REQ\',\'rate-keep\',{kinds:[9702],\'#t\':[\'keep\']}]))', origin)
    await browser.until(() => browser.evaluate('bridgeTest.frames.some(frame=>frame.id === "rate-keep" && frame.op === "EOSE")', origin), 'active subscription before cooldown')
    await browser.evaluate('bridgeTest.sockets[0].send(JSON.stringify([\'REQ\',\'rate-limit\',{kinds:[9701],\'#t\':[\'limited\']}]))', origin)
    await browser.until(() => browser.evaluate('bridgeTest.frames.some(frame=>frame.op === "CLOSED" && frame.id === "rate-limit")', origin), 'rate rejection through real port')
    await browser.evaluate(`
      bridgeTest.sockets[0].send(JSON.stringify(['REQ','rate-next',{kinds:[9702],'#t':['next']}]))
      bridgeTest.sockets[0].send(JSON.stringify(['REQ','rate-cancel',{kinds:[9702],'#t':['cancel']}]))
      bridgeTest.sockets[0].send(JSON.stringify(['CLOSE','rate-cancel']))
      bridgeTest.sockets[0].send(JSON.stringify(['CLOSE','rate-keep']))
    `, origin)
    await browser.until(() => browser.evaluate('bridgeTest.frames.some(frame=>frame.op === "EOSE" && frame.id === "rate-next")', origin), 'work resumes after cooldown')
    const traffic = await browser.evaluate('transport.frames')
    const limited = traffic.findLast(frame => frame.marker === 'limited')
    const next = traffic.findLast(frame => frame.marker === 'next')
    const keep = traffic.findLast(frame => frame.marker === 'keep')
    const close = traffic.findLast(frame => frame.op === 'CLOSE' && frame.id === keep.id)
    assert.ok(next.at - limited.at >= 950, 'work honors retry_after')
    assert.ok(close.at < next.at, 'CLOSE precedes work held by cooldown')
    assert.ok(!traffic.some(frame => frame.marker === 'cancel'), 'cancelled REQ never reaches the relay')
    await browser.until(() => browser.evaluate('bridgeTest.credits.some(item=>Number.isInteger(item.through)&&item.returnedAt>=item.receivedAt)', origin), 'sequenced credits with cross-context timing')
    await browser.evaluate('bridgeTest.open()', origin)
    const opened = await browser.evaluate('transport.opened')
    await browser.evaluate("bridgeTest.sockets[1].send(JSON.stringify(['REQ','oversize',{kinds:[9700],'#t':['oversize']}]))", origin)
    await browser.until(() => browser.evaluate('bridgeTest.closes.length === 1', origin), 'oversized virtual socket closed')
    assert.deepEqual(await browser.evaluate('bridgeTest.closes[0]', origin), { code: 1013, reason: 'relay bridge frame too large' })
    assert.equal(await browser.evaluate('transport.opened'), opened, 'overflow never falls back to a direct socket')
    assert.equal(await browser.evaluate('bridgeTest.sockets[0].readyState', origin), 1, 'other virtual socket survives')
    await browser.evaluate("bridgeTest.frames=[];bridgeTest.sockets[0].send(JSON.stringify(['REQ','after-overflow',{kinds:[9700],'#t':['burst']}]))", origin)
    await browser.until(() => browser.evaluate('bridgeTest.frames.length === 83 && bridgeTest.frames.at(-1).op === "EOSE"', origin), 'shared physical socket remains usable')
    await browser.evaluate('bridgeTest.sockets.forEach(socket=>socket.close())', origin)
  }
  console.log('Real launcher/app/vault bridge: busy-consumer bursts, repeated REQ, FIFO, 2 MiB isolated frames, credit metadata and oversized virtual-only closure passed.')
} catch (error) {
  await browser?.diagnose(root + '/tmp/browser-failures/relay-bridge')
  throw error
} finally {
  await browser?.close()
  await runtime.close()
}
