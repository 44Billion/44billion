import assert from 'node:assert/strict'

export default async function checkSignerCapabilities ({ evaluate, until, cdp }) {
  const a = '11'.repeat(32)
  const b = '33'.repeat(32)
  const legacy = '44'.repeat(32)
  const supported = Array.from({ length: 3 }, () => [true, true, true])
  const unsupported = Array.from({ length: 3 }, () => [false, false, false])
  const snapshot = capability => ({
    pubkey: a, isReadOnly: false, isLocked: true,
    profile: { meta: { events: [] } }, relays: { meta: { events: [] } },
    ...(capability === undefined ? {} : { supportsContentKeyMethods: capability })
  })
  const accounts = [snapshot(true), { ...snapshot(false), pubkey: b }, { ...snapshot(), pubkey: legacy }]
  const query = () => evaluate(`new Promise((resolve,reject)=>{
    const frame=document.querySelector('app-window iframe');
    const origin=new URL(frame.src).origin;
    const requestId=Math.random();
    const timer=setTimeout(()=>{window.removeEventListener('message',receive);reject(Error('Capability query timed out'))},4000);
    const receive=e=>{if(e.source!==frame.contentWindow||e.origin!==origin||e.data.requestId!==requestId)return;
      clearTimeout(timer);window.removeEventListener('message',receive);resolve(e.data.payload)};
    window.addEventListener('message',receive);
    frame.contentWindow.postMessage({code:'FIXTURE_PERSONA_QUERY',requestId,pubkeys:${JSON.stringify([a, b, legacy])}},origin);
  })`)
  // Persist through the production account writer. The fixture has no vault
  // connection and deliberately does not replay this snapshot after reload.
  await evaluate(`fixture.setAccountsState(${JSON.stringify(accounts)},fixture.storage,fixture.tabStorage)`)
  const firstBoot = await evaluate('fixture.bootId')
  await cdp('Page.reload')
  await until(`window.fixture?.bootId!==${JSON.stringify(firstBoot)} && window.fixture?.loaded.some(item=>item.metadata.instanceKey==='window')`, 'app opens after launcher reload without a vault')
  assert.equal(await evaluate('fixture.signerConnection()'), 'unknown')
  assert.deepEqual((await query()).contentMethods.owner, supported)
  await evaluate(`fixture.storage.local_personas$({capabilities:{userPks:[fixture.userPk,fixture.toBase62(${JSON.stringify(b)}),fixture.toBase62(${JSON.stringify(legacy)})],createdAt:1}});
    fixture.setAppPersonaSelection({localStorageArea:localStorage,wsKey:'ws',appId:fixture.appId,personaId:'capabilities'})`)
  await until('fixture.storage.local_appPersonaSelections$()?.ws?.[fixture.appId]===\'capabilities\'', 'cached persona selected')
  await until('!!document.querySelector("app-window iframe")', 'app frame ready')
  const before = await query()
  assert.deepEqual(before.contentMethods.scoped, [supported, unsupported, supported])
  assert.equal(await evaluate(`localStorage.getItem('session_accountByUserPk_'+fixture.toBase62(${JSON.stringify(legacy)})+'_supportsContentKeyMethods')`), null)
  const recovered = accounts.map(account => ({ ...account, supportsContentKeyMethods: account.pubkey === b }))
  await evaluate(`fixture.setSignerAccounts(${JSON.stringify(recovered)});
    fixture.setAccountsState(${JSON.stringify(recovered)},fixture.storage,fixture.tabStorage)`)
  const after = await query()
  assert.equal(after.token, before.token, 'capability recovery does not reload the app')
  assert.deepEqual(after.contentMethods.owner, unsupported)
  assert.deepEqual(after.contentMethods.scoped, [unsupported, supported, unsupported])
  // A second launcher reload must use the changed value, not the old capability.
  const secondBoot = await evaluate('fixture.bootId')
  await cdp('Page.reload')
  await until(`window.fixture?.bootId!==${JSON.stringify(secondBoot)} && window.fixture?.loaded.some(item=>item.metadata.instanceKey==='window')`, 'app opens with updated cached capability')
  assert.equal(await evaluate('fixture.signerConnection()'), 'unknown')
  assert.deepEqual((await query()).contentMethods.owner, unsupported)
  console.log('Chrome cached signer capabilities passed: cold app opening without vault, unpersisted legacy fallback, live recovery and persisted changes.')
}
