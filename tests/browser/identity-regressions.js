import assert from 'node:assert/strict'

export default async function checkIdentity ({ evaluate, until, wait, port, send, cdp }) {
  const query = (selector, code = 'FIXTURE_PERSONA_QUERY', extra = {}) => evaluate(`new Promise((resolve,reject)=>{
    const frame=document.querySelector(${JSON.stringify(selector)});
    const origin=new URL(frame.src).origin;
    const requestId=Math.random();
    const timer=setTimeout(()=>{window.removeEventListener('message',receive);reject(Error('Identity reply timed out'))},4000);
    const receive=e=>{if(e.source!==frame.contentWindow||e.origin!==origin||e.data.requestId!==requestId)return;
      clearTimeout(timer);window.removeEventListener('message',receive);resolve(e.data.payload)};
    window.addEventListener('message',receive);
    frame.contentWindow.postMessage({code:${JSON.stringify(code)},requestId,pubkeys:[],...${JSON.stringify(extra)}},origin);
  })`)
  await evaluate(`
    fixture.storage.session_defaultUserPk$(fixture.userPk);
    fixture.storage.session_accountUserPks$([fixture.userPk]);
    fixture.storage.session_workspaceByKey_ws_userPk$(fixture.userPk);
    fixture.subdomainStorage()['session_subdomainByUserAndApp_'+fixture.userPk+'_'+fixture.appId+'$']('3');
    fixture.subdomainStorage().session_subdomainToApp_3$({userPk:fixture.userPk,appId:fixture.appId});
    fixture.storage.session_appByKey_window_route$('/kept-window');
    fixture.tabStorage.session_appByKey_window_visibility$('minimized');
    fixture.storage.local_widgets$({widget:{appId:fixture.appId,wsKey:'ws',row:0,col:0,desired:{w:3,h:2},pinnedRoute:'/kept-widget',isPinned:true,createdAt:1,updatedAt:1}});
    fixture.storage.local_widgets$(records=>({...records,
      sleeping:{...records.widget,col:4,desired:{w:2,h:2},pinnedRoute:'/sleeping',createdAt:2},
      closed:{...records.widget,col:7,desired:{w:2,h:2},pinnedRoute:'/closed',createdAt:3}
    }));
    fixture.state.single$(true);
  `)
  await until("fixture.getAppBridgeState('3')?.windows.size===5 && [...fixture.getAppBridgeState('3').windows.values()].every(entry=>entry.widgetPort)", 'three kinds of instance load as the default user')
  const windowFrame = 'app-window iframe'
  const widgetFrame = 'widget-window iframe'
  const singleFrame = 'single-napp-launcher iframe.napp-page'
  const sleepingFrame = 'widget-window:nth-of-type(2) iframe'
  await evaluate("fixture.tabStorage.session_widgetByKey_sleeping_visibility$('minimized');fixture.tabStorage.session_widgetByKey_closed_visibility$('closed')")
  await until("fixture.getAppBridgeState('3').windows.size===4", 'closed widget disconnects')
  const before = await Promise.all([windowFrame, widgetFrame, singleFrame, sleepingFrame].map(selector => query(selector)))
  assert.equal(before[0].peek, '11'.repeat(32))
  assert.equal(before[0].href, '/kept-window')
  await query(windowFrame, 'FIXTURE_STORAGE', { value: 'default-data' })
  await evaluate(`fixture.setAccountsState([{pubkey:'${'44'.repeat(32)}',profile:{},relays:{},isReadOnly:true}],fixture.storage,fixture.tabStorage)`)
  await until("fixture.getAppBridgeSpecs()().some(spec=>spec.userPk===fixture.toBase62('" + '44'.repeat(32) + "') && fixture.getAppBridgeState(spec.appSubdomain).windows.size===4 && [...fixture.getAppBridgeState(spec.appSubdomain).windows.values()].every(entry=>entry.widgetPort))", 'ownership change reloads windows, widgets and isolated apps')
  const after = await Promise.all([windowFrame, widgetFrame, singleFrame, sleepingFrame].map(selector => query(selector)))
  await until("[...document.querySelectorAll('widget-window iframe')].filter(frame=>frame.src!=='about:blank').every(frame=>frame.style.width==='360px')", 'open and minimized widgets retain auto-fit after ownership reload')
  for (let i = 0; i < after.length; i++) {
    assert.equal(after[i].peek, '44'.repeat(32))
    assert.notEqual(after[i].token, before[i].token)
    assert.equal(after[i].href, before[i].href)
  }
  assert.equal(await evaluate('fixture.tabStorage.session_appByKey_window_visibility$()'), 'minimized')
  assert.equal(await evaluate('fixture.storage.local_widgets$().widget.isPinned'), true)
  assert.equal(await evaluate('fixture.tabStorage.session_widgetByKey_sleeping_visibility$()'), 'minimized')
  assert.equal(await evaluate('fixture.tabStorage.session_widgetByKey_closed_visibility$()'), 'closed')
  await evaluate("fixture.tabStorage.session_widgetByKey_closed_visibility$('open')")
  await until("fixture.instanceMetadata.getMetadata('closed')?.isLoaded", 'closed widget reopens with the new identity')
  await until("document.querySelector('widget-window:nth-of-type(3) iframe').style.width==='360px'", 'closed widget restores auto-fit when opened under the new identity')
  assert.equal((await query('widget-window:nth-of-type(3) iframe')).peek, '44'.repeat(32))
  assert.deepEqual(await query(windowFrame, 'FIXTURE_STORAGE'), { local: null, session: null, db: null })
  await until("(fixture.subdomainStorage().session_subdomainFreeIds$()??[]).includes('3')", 'retired default origin is cleaned before recycling', 10000)

  // A cold cleanup has no app mapping, manifest, files or installed SW.
  assert.equal(await evaluate("fixture.askAppToClearData('99',{strict:true,timeoutMs:12000})"), true)

  // A different launcher tab reassigns the cleaned origin. The first tab still
  // has its old origin-3 sessionStorage, so its next bootstrap must clear it.
  const { targetId } = await send('Target.createTarget', { url: `http://localhost:${port}/storage-fixture` })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  try {
    await send('Runtime.enable', {}, sessionId)
    await wait(150)
    const appId = await evaluate('fixture.appId')
    const nextUser = await evaluate(`fixture.toBase62('${'55'.repeat(32)}')`)
    const expression = `localStorage.setItem('session_subdomainToApp_3',JSON.stringify({userPk:${JSON.stringify(nextUser)},appId:${JSON.stringify(appId)}}));
      localStorage.setItem(${JSON.stringify(`session_subdomainByUserAndApp_${nextUser}_${appId}`)},JSON.stringify('3'));
      const lifecycle=JSON.parse(localStorage.getItem('local_subdomainLifecycle'));lifecycle.assignments['3']='cross-tab-assignment';localStorage.setItem('local_subdomainLifecycle',JSON.stringify(lifecycle));
      localStorage.setItem('session_subdomainFreeIds',JSON.stringify([]));
      localStorage.setItem('session_workspaceByKey_ws_userPk',JSON.stringify(${JSON.stringify(nextUser)}));`
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true }, sessionId)
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    await cdp('Page.bringToFront')
    await until("fixture.getAppBridgeState('3')?.userPk==='" + nextUser + "' && [...fixture.getAppBridgeState('3').windows.values()].every(entry=>entry.widgetPort) && fixture.getAppBridgeState('3').windows.size===5", 'cross-tab change binds all instances to the recycled origin')
    assert.deepEqual(await query(windowFrame, 'FIXTURE_STORAGE'), { local: null, session: null, db: null })
    assert.equal((await query(widgetFrame)).peek, '55'.repeat(32))
  } finally { await send('Target.closeTarget', { targetId }) }
  await evaluate("fixture.tabStorage.session_appByKey_window_visibility$('closed');fixture.state.single$(false)")
  await until("fixture.getAppBridgeState('3').windows.size===3", 'widgets are the only remaining instances')
  await evaluate("fixture.storage.session_workspaceByKey_ws_userPk$(fixture.toBase62('" + '66'.repeat(32) + "'))")
  await wait(50)
  await evaluate("fixture.storage.session_workspaceByKey_ws_userPk$(fixture.toBase62('" + '77'.repeat(32) + "'))")
  await until("fixture.getAppBridgeSpecs()().some(spec=>spec.userPk===fixture.toBase62('" + '77'.repeat(32) + "') && fixture.getAppBridgeState(spec.appSubdomain).windows.size===3 && [...fixture.getAppBridgeState(spec.appSubdomain).windows.values()].every(entry=>entry.widgetPort))", 'widgets alone replace an in-flight identity handshake')
  assert.equal((await query(widgetFrame)).peek, '77'.repeat(32))
  console.log('Chrome identity regression passed: ownership reload, preserved routes/minimization, cold origin cleanup and recycled sessions')
}
