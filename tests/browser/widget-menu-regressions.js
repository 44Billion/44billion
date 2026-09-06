import assert from 'node:assert/strict'

export default async ({ cdp, evaluate, wait, root, select }) => {
  const results = []
  await evaluate("fixture.storage.session_accountUserPks$(['user','member']);fixture.storage.session_accountByUserPk_user_profile$({name:'Workspace account'});fixture.storage.local_personas$({team:{userPks:['user','member'],createdAt:1},foreign:{userPks:['member'],createdAt:2}})")
  await evaluate('fixture.menuRecord=fixture.storage.local_widgets$().tiny;fixture.storage.local_widgets$({})')
  for (const [viewportWidth, fallback] of [[800, false], [800, true], [360, false], [360, true]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: viewportWidth, height: 600, deviceScaleFactor: 1, mobile: false })
    await wait(120)
    if (fallback) await evaluate("window.originalSupports=CSS.supports;CSS.supports=(...args)=>args[0]==='position-anchor'?false:originalSupports(...args)")
    // Reuse the menu so reopening also catches stale positions after a move.
    const key = `menu${viewportWidth}${fallback}`
    for (const [w, col, row] of [[1, 0, 4], [1, 1, 4], [1, 2, 4], [2, 1, 4], [1, viewportWidth === 800 ? 11 : 4, 8]]) {
      await evaluate(`fixture.storage.local_widgets$({${key}:{...fixture.menuRecord,row:${row},col:${col},desired:{w:${w},h:1}}})`)
      await wait(120)
      await select(key)
      const frames = await evaluate(`new Promise(resolve=>{
        const root=${root(key)};
        const dialog=root.querySelector('dialog');
        const frames=[];
        let count=0;
        const sample=()=>{
          const rect=dialog.getBoundingClientRect();
          if(dialog.matches(':popover-open')&&getComputedStyle(dialog).visibility==='visible'&&rect.width>0){
            const items=[...dialog.querySelectorAll('.widget-action-item')].map(item=>{
              const text=item.querySelector(':scope > span:last-child');
              const range=document.createRange();range.selectNodeContents(text);
              const lines=[...range.getClientRects()].length;
              const icon=item.querySelector('svg')?.getBoundingClientRect();
              return {lines,iconWidth:icon?.width??null};
            });
            frames.push({x:rect.x,y:rect.y,width:rect.width,height:rect.height,items});
          }
          if(++count<24)requestAnimationFrame(sample);else resolve(frames);
        };
        root.querySelector('.widget-remove-button').click();
        requestAnimationFrame(sample);
      })`)
      if (!frames.length) throw new Error(await evaluate(`JSON.stringify({errors:fixtureErrors,html:${root(key)}.querySelector('dialog').outerHTML})`))
      results.push({ viewportWidth, fallback, w, col, row, frames })
      await evaluate(`${root(key)}.querySelector('.widget-action-item:last-child').click()`)
      await wait(220)
      const options = await evaluate(`[...${root(key)}.querySelectorAll('.persona-option')].map(item=>item.dataset.personaId)`)
      assert.deepEqual(options, ['', '__default__', 'team'])
      assert.equal(await evaluate(`[...${root(key)}.querySelectorAll('icon-users-group')].every(icon=>getComputedStyle(icon.parentElement).overflow==='visible')`), true, 'group icons are not clipped by an avatar mask')
      const fit = await evaluate(`(()=>{const r=${root(key)}.querySelector('dialog').getBoundingClientRect();return r.width>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`)
      assert.equal(fit, true, 'replacement selector stays inside viewport')
      await evaluate(`${root(key)}.querySelector('[data-persona-id="__default__"]').click()`)
      await wait(80)
      assert.equal(await evaluate('fixture.storage.local_appPersonaSelections$().ws.app'), '__default__')
      assert.equal(await evaluate(`${root(key)}.querySelector('dialog').matches(':popover-open')`), false)
      await evaluate('fixture.storage.local_appPersonaSelections$({})')
      await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")
      await wait(80)
    }
    await evaluate('fixture.storage.local_widgets$({})')
    if (fallback) await evaluate('CSS.supports=originalSupports')
  }
  for (const { viewportWidth, fallback, w, col, row, frames } of results) {
    const label = `${fallback ? 'fallback' : 'anchors'} ${w}x1 at ${col},${row}, viewport ${viewportWidth}`
    assert.ok(frames.length, `${label}: menu becomes visible`)
    const final = frames.at(-1)
    assert.equal(final.items.length, 3, `${label}: all actions are rendered`)
    assert.ok(final.items.every(item => item.lines === 1 && Math.abs(item.iconWidth - 16) < 0.1), `${label}: labels and icons keep their natural size: ${JSON.stringify(final)}`)
    assert.ok(frames.every(frame => ['x', 'y', 'width', 'height'].every(key => Math.abs(frame[key] - final[key]) < 0.1)), `${label}: first visible frame already has the final geometry: ${JSON.stringify(frames)}`)
    assert.ok(final.x >= 0 && final.y >= 0 && final.x + final.width <= viewportWidth && final.y + final.height <= 600, `${label}: fits viewport`)
  }
  // Direct selector, caret, compact widths, focus and geometry use real components.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false })
  for (const [w, h] of [[1, 3], [2, 2], [3, 2]]) {
    await evaluate(`fixture.storage.local_widgets$({direct:{...fixture.menuRecord,row:1,col:1,desired:{w:${w},h:${h}}}})`)
    await wait(120)
    await select('direct')
    const control = await evaluate(`(()=>{const root=${root('direct')};return {direct:!!root.querySelector('.widget-persona-button'),caret:!!root.querySelector('.widget-persona-button icon-chevron-left'),buttons:root.querySelectorAll('.widget-remove-button').length}})()`)
    assert.deepEqual(control, { direct: w >= 2, caret: w >= 3, buttons: w === 1 ? 1 : 2 })
    if (w === 1) continue
    const geometry = await evaluate(`(()=>{const e=${root('direct')}.querySelector('.widget-persona-avatar');const r=e.getBoundingClientRect();const s=getComputedStyle(e);return {width:r.width,height:r.height,border:s.borderWidth}})()`)
    assert.deepEqual(geometry, { width: 26, height: 26, border: '2px' })
    await evaluate(`${root('direct')}.querySelector('.widget-persona-button').click()`)
    await wait(220)
    assert.equal(await evaluate("document.activeElement?.getAttribute('aria-checked')"), 'true')
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown' })
    assert.equal(await evaluate('document.activeElement?.dataset.personaId'), '__default__')
    await evaluate(`${root('direct')}.querySelector('[data-persona-id="team"]').click()`)
    await wait(80)
    assert.equal(await evaluate('fixture.storage.local_appPersonaSelections$().ws.app'), 'team')
    await evaluate("fixture.storage.local_personas$({team:{userPks:['member'],createdAt:1},foreign:{userPks:['member'],createdAt:2}})")
    await wait(80)
    assert.equal(await evaluate('fixture.storage.local_appPersonaSelections$().ws?.app??null'), null)
    await evaluate("fixture.storage.local_personas$({team:{userPks:['user','member'],createdAt:1},foreign:{userPks:['member'],createdAt:2}})")
  }
  await evaluate("fixture.storage.session_defaultUserPk$('user')")
  await wait(80)
  const avatarGeometry = () => evaluate(`(()=>{
    const avatar=${root('direct')}.querySelector('.widget-persona-avatar');
    const rect=avatar.getBoundingClientRect();
    const svg=avatar.querySelector('svg').getBoundingClientRect();
    const style=getComputedStyle(avatar);
    return {width:rect.width,height:rect.height,border:style.borderWidth,shadow:style.boxShadow,svgWidth:svg.width,svgHeight:svg.height};
  })()`)
  assert.deepEqual(await avatarGeometry(), { width: 26, height: 26, border: '0px', shadow: 'none', svgWidth: 26, svgHeight: 26 }, 'default user uses the full control size and its own SVG border')
  await evaluate(`${root('direct')}.querySelector('.widget-persona-button').click()`)
  await wait(220)
  assert.equal(await evaluate(`${root('direct')}.querySelector('[data-persona-id=""] a-avatar svg').getBoundingClientRect().width`), 16, 'default user stays at menu icon size in the selector')
  await evaluate(`${root('direct')}.querySelector('[data-persona-id="team"]').click()`)
  await wait(80)
  assert.equal((await avatarGeometry()).border, '2px', 'selecting a persona restores the control border')
  await evaluate('fixture.storage.local_appPersonaSelections$({})')
  await wait(80)
  assert.equal((await avatarGeometry()).svgWidth, 26, 'reset restores the larger default avatar')
  assert.deepEqual(await evaluate('fixtureErrors'), [])
  console.log('Chrome widget menus passed: natural width and stable first visible position, with CSS anchors and fallback')
}
