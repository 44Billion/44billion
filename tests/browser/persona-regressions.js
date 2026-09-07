import assert from 'node:assert/strict'

export default async function checkPersonas ({ evaluate, until, wait, port, send }) {
  const a = '11'.repeat(32)
  const b = '33'.repeat(32)
  const request = (selector, pubkeys = []) => evaluate(`new Promise((resolve,reject)=>{
    const frame=document.querySelector(${JSON.stringify(selector)});
    const requestId=Math.random();
    const timer=setTimeout(()=>{window.removeEventListener('message',receive);reject(Error('Persona fixture reply timed out'))},3000);
    const receive=e=>{if(e.source!==frame.contentWindow||e.data?.code!=='FIXTURE_PERSONA_REPLY'||e.data.requestId!==requestId)return;
      clearTimeout(timer);window.removeEventListener('message',receive);resolve(e.data.payload)};
    window.addEventListener('message',receive);
    frame.contentWindow.postMessage({code:'FIXTURE_PERSONA_QUERY',requestId,pubkeys:${JSON.stringify(pubkeys)}},'http://0.localhost:${port}');
  })`)
  const windowFrame = 'app-window iframe'
  const widgetFrame = 'widget-window iframe'
  const original = await request(windowFrame, [a, b])
  const originalWidget = await request(widgetFrame)
  assert.deepEqual(original.keys, [a])
  assert.deepEqual(original.signers, [a, { error: 'PUBKEY_NOT_IN_PERSONA' }])
  assert.deepEqual(original.eventStores, [true, { error: 'PUBKEY_NOT_IN_PERSONA' }])
  assert.deepEqual(original.changes, [[a]])

  // The real toolbar menu should offer the selected app's eligible identities.
  await evaluate(`fixture.memberB62=fixture.toBase62(${JSON.stringify(b)});
    fixture.storage.session_defaultUserPk$('guest');
    fixture.storage.session_accountUserPks$([fixture.userPk,fixture.memberB62]);
    fixture.storage.local_personas$({team:{userPks:[fixture.userPk,fixture.memberB62],createdAt:1},foreign:{userPks:[fixture.memberB62],createdAt:2}});
    document.querySelector('#fixture-menu-anchor').click();`)
  await until("!!document.querySelector('.persona-action icon-users-plus')", 'toolbar shows the add-users icon')
  assert.equal(await evaluate("document.querySelector('#scope_pfgf892').lastElementChild.className"), 'persona-action')
  await evaluate("document.querySelector('.persona-action').click()")
  await until("document.querySelectorAll('.persona-option').length===3", 'toolbar selector replaces actions')
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.persona-option')].map(e=>e.dataset.personaId)"), ['', '__default__', 'team'])
  assert.equal(await evaluate("!!document.querySelector('.persona-option a-avatar')"), true)
  await evaluate("document.querySelector('[data-persona-id=team]').click()")
  await wait(100)
  const selected = await request(windowFrame, [a, b])
  const selectedWidget = await request(widgetFrame, [b])
  assert.deepEqual(selected.keys, [a, b])
  assert.deepEqual(selected.signers, [a, b])
  assert.deepEqual(selected.eventStores, [true, true])
  assert.deepEqual(selectedWidget.eventStores, [true])
  assert.deepEqual(selectedWidget.keys, [a, b])
  assert.deepEqual(selected.changes, [[a], [a, b]])
  assert.equal(selected.token, original.token)
  assert.equal(selectedWidget.token, originalWidget.token)

  await evaluate("fixture.tabStorage.session_appByKey_window_visibility$('minimized');fixture.updatePersonaUserPks({localStorageArea:localStorage,personaId:'team',userPks:[fixture.memberB62]})")
  await wait(100)
  const reset = await request(windowFrame, [b, null, ''])
  assert.deepEqual(reset.keys, [a])
  assert.deepEqual(reset.signers, Array(3).fill({ error: 'PUBKEY_NOT_IN_PERSONA' }))
  assert.deepEqual(reset.eventStores, Array(3).fill({ error: 'PUBKEY_NOT_IN_PERSONA' }))
  assert.deepEqual(reset.changes, [[a], [a, b], [a]])
  assert.deepEqual((await request(widgetFrame)).changes, [[a], [a, b], [a]])
  assert.equal(await evaluate('fixture.storage.local_appPersonaSelections$().ws?.[fixture.appId]??null'), null)
  assert.equal(reset.token, original.token)
  await evaluate("fixture.tabStorage.session_appByKey_window_visibility$('open')")

  // A persona with the same single key resets without a redundant event.
  await evaluate("fixture.storage.local_personas$({solo:{userPks:[fixture.userPk],createdAt:3}});fixture.setAppPersonaSelection({localStorageArea:localStorage,wsKey:'ws',appId:fixture.appId,personaId:'solo'})")
  await wait(60)
  await evaluate('fixture.storage.local_personas$({})')
  await wait(60)
  assert.equal((await request(windowFrame)).changes.length, 3)

  // A native storage event from another tab updates both UI and live APIs.
  const { targetId } = await send('Target.createTarget', { url: `http://localhost:${port}/storage-fixture` })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  try {
    await send('Runtime.enable', {}, sessionId)
    const appId = await evaluate('fixture.appId')
    const expression = `localStorage.setItem('local_appPersonaSelections', JSON.stringify({ws:{[${JSON.stringify(appId)}]:'__default__'}}))`
    let result
    for (let tries = 0; tries < 30; tries++) {
      result = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
      if (!result.exceptionDetails) break
      await wait(50)
    }
    assert.equal(result.exceptionDetails, undefined)
    await until("fixture.storage.local_appPersonaSelections$()?.ws?.[fixture.appId]==='__default__'", 'selection syncs from another tab')
    await wait(60)
    assert.deepEqual((await request(windowFrame)).keys, [a, b])
  } finally {
    await send('Target.closeTarget', { targetId })
  }
  await evaluate("fixture.tabStorage.session_appByKey_peer_visibility$('open')")
  await until("fixture.instanceMetadata.getMetadata('peer')?.isLoaded", 'future instance inherits the selection')
  assert.deepEqual((await request('app-window:nth-of-type(2) iframe')).keys, [a, b])
  await evaluate("fixture.tabStorage.session_appByKey_peer_visibility$('closed');fixture.setAppPersonaSelection({localStorageArea:localStorage,wsKey:'ws',appId:fixture.appId,personaId:null});fixture.storage.session_defaultUserPk$(fixture.userPk)")
  await wait(60)
  assert.deepEqual(await evaluate('fixtureErrors'), [])
  console.log('Chrome persona APIs passed: shared selector, live and minimized documents, scoped signers, resets and future instances')
}
