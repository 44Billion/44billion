import assert from 'node:assert/strict'

export default async ({ cdp, evaluate, wait, root, select }) => {
  const results = []
  for (const pointerType of ['mouse', 'touch']) {
    await evaluate('fixture.storage.local_widgets$(all=>({...all,tall:{...all.tall,row:3,col:3,desired:{w:3,h:3}}}))')
    await wait(120)
    const start = await evaluate(`(()=>{const r=${root('tall')}.getBoundingClientRect();return {x:r.left+35,y:r.top+8,top:r.top}})()`)
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: pointerType === 'touch', maxTouchPoints: 1 })
    const input = async (phase, x, y) => {
      if (pointerType === 'mouse') {
        await cdp('Input.dispatchMouseEvent', { type: { down: 'mousePressed', move: 'mouseMoved', up: 'mouseReleased' }[phase], x, y, button: 'left', buttons: phase === 'up' ? 0 : 1, clickCount: 1 })
      } else {
        await cdp('Input.dispatchTouchEvent', { type: { down: 'touchStart', move: 'touchMove', up: 'touchEnd' }[phase], touchPoints: phase === 'up' ? [] : [{ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 }] })
      }
    }
    if (pointerType === 'mouse') {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, buttons: 0 })
      await wait(80)
    }
    await input('down', start.x, start.y)
    await wait(700)
    assert.equal(await evaluate(`${root('tall')}.classList.contains('widget-window-dragging')`), true, `${pointerType}: initial iframe longpress still starts drag`)
    await input('up', start.x, start.y)
    await wait(120)
    assert.equal(await evaluate(`${root('tall')}.classList.contains('widget-window-selected')`), true)
    await input('down', start.x, start.y)
    await wait(80)
    for (let dy = 8; dy <= 80; dy += 8) {
      await input('move', start.x, start.y - dy)
      await wait(30)
    }
    await input('up', start.x, start.y - 80)
    await wait(100)
    results.push(await evaluate(`(()=>{const el=${root('tall')};return {pointerType:'${pointerType}',before:${start.top},after:el.getBoundingClientRect().top,dragging:el.classList.contains('widget-window-dragging'),selected:el.classList.contains('widget-window-selected')}})()`))
    await evaluate("document.querySelector('iframe[data-key=tall]').contentWindow.postMessage({code:'fixture-reset'},'*')")
    await wait(60)
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")
    await wait(80)
  }
  for (const result of results) {
    assert.ok(result.after < result.before, `${result.pointerType}: second drag moves upward from near the top`)
    assert.equal(result.dragging, false, `${result.pointerType}: release above the moving iframe ends drag`)
    assert.equal(result.selected, true, `${result.pointerType}: release returns to resize selection`)
  }
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: false })

  for (const [w, h] of [[1, 1], [3, 1], [1, 3], [3, 3]]) {
    await evaluate(`fixture.storage.local_widgets$(all=>({...all,tall:{...all.tall,row:3,col:3,desired:{w:${w},h:${h}}}}))`)
    await wait(120)
    await select('tall')
    const hitTargets = await evaluate(`(()=>{
      const root=${root('tall')};
      const controls=[...root.querySelectorAll('.widget-remove-button')].map(button=>{
        const r=button.getBoundingClientRect();
        return [3,r.width/2,r.width-3].every(x=>[3,r.height/2,r.height-3].every(y=>document.elementFromPoint(r.x+x,r.y+y)?.closest('button')===button));
      });
      const nodes=[...root.querySelectorAll('.widget-resize-node')].map(button=>{
        const r=button.getBoundingClientRect();return document.elementFromPoint(r.x+6,r.y+6)?.closest('button')===button;
      });
      return {controls,nodes};
    })()`)
    assert.ok(hitTargets.controls.every(Boolean), `${w}x${h}: all button interiors remain clickable`)
    assert.deepEqual(hitTargets.nodes, [true, true, true, true], `${w}x${h}: all resize nodes remain reachable`)
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    const buttonSelector = h === 1 ? '.widget-remove-button' : '.widget-pin-button'
    const point = await evaluate(`(()=>{const r=${root('tall')}.querySelector('${buttonSelector}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+3}})()`)
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, radiusX: 8, radiusY: 8, force: 1, id: 1 }] })
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await wait(180)
    assert.equal(await evaluate(`${root('tall')}.classList.contains('widget-window-dragging')`), false)
    if (h === 1) {
      assert.equal(await evaluate(`${root('tall')}.querySelector('dialog').matches(':popover-open')`), true, `${w}x${h}: touch near button edge opens options`)
    } else {
      assert.equal(await evaluate('fixture.storage.local_widgets$().tall.isPinned'), true, `${w}x${h}: touch near pin button edge toggles pin`)
      await evaluate('fixture.storage.local_widgets$(all=>({...all,tall:{...all.tall,isPinned:false}}))')
    }
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")
    await wait(80)
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: false })
  }
  assert.deepEqual(await evaluate('fixtureErrors'), [])
  console.log('Chrome cross-origin regression checks passed: upward second drag, outside release, compact control hit areas and touch activation')
}
