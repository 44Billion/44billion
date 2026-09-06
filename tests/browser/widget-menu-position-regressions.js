import assert from 'node:assert/strict'

export default async function checkMenuPositions ({ cdp, evaluate, wait, root, select }) {
  const geometry = () => evaluate(`(()=>{
    const root=${root('positioned')};
    const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
    const button=root.querySelector('.widget-persona-button')??root.querySelector('.widget-remove-button');
    return {anchor:rect(root),button:rect(button),menu:rect(root.querySelector('dialog'))};
  })()`)
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1, `${label}: ${actual} vs ${expected}`)
  for (const width of [800, 360]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 1, mobile: false })
    for (const fallback of [false, true]) {
      if (fallback) await evaluate("window.originalSupports=CSS.supports;CSS.supports=(...args)=>args[0]==='position-anchor'?false:originalSupports(...args)")
      const edge = width === 800 ? 11 : 3
      for (const [w, h, row, col] of [[1, 1, 4, 1], [2, 1, 4, 1], [1, 3, 4, 1], [2, 2, 4, 1], [3, 2, 4, 1], [2, 2, 0, 1], [2, 2, 4, edge], [2, 2, 0, edge]]) {
        await evaluate(`fixture.storage.local_widgets$({positioned:{...fixture.menuRecord,row:${row},col:${col},desired:{w:${w},h:${h}}}})`)
        await wait(120)
        await select('positioned')
        const { anchor, button } = await geometry()
        const label = `${width} ${fallback ? 'fallback' : 'anchors'} ${w}x${h} at ${row},${col}`
        if (h === 1) near(button.top + button.height / 2, anchor.top + anchor.height / 2, `${label} vertical center`)
        else near(button.top, anchor.top + 6, `${label} top inset`)
        if (w === 1) near(button.left + button.width / 2, anchor.left + anchor.width / 2, `${label} horizontal center`)
        // Sample the full button, including the part nearest the resize nodes.
        assert.equal(await evaluate(`(()=>{const root=${root('positioned')};const b=root.querySelector('.widget-persona-button')??root.querySelector('.widget-remove-button');const r=b.getBoundingClientRect();return [[r.width/2,2],[r.width/2,r.height-2],[2,r.height/2],[r.width-2,r.height/2],[r.width/2,r.height/2]].every(([x,y])=>b.contains(document.elementFromPoint(r.left+x,r.top+y)))})()`), true, `${label} button hit area`)
        const frames = await evaluate(`new Promise(resolve=>{
          const root=${root('positioned')};const dialog=root.querySelector('dialog');const frames=[];let n=0;
          const sample=()=>{const r=dialog.getBoundingClientRect();if(dialog.matches(':popover-open')&&getComputedStyle(dialog).visibility==='visible'&&r.width)frames.push({left:r.left,top:r.top,width:r.width,height:r.height});if(++n<48&&frames.length<12)requestAnimationFrame(sample);else resolve(frames)};
          (root.querySelector('.widget-persona-button')??root.querySelector('.widget-remove-button')).click();requestAnimationFrame(sample);
        })`)
        assert.ok(frames.length, `${label} opens: ${frames.length ? '' : await evaluate(`JSON.stringify({errors:fixtureErrors,html:${root('positioned')}.outerHTML})`)}`)
        const final = frames.at(-1)
        for (const frame of frames) for (const key of ['left', 'top', 'width', 'height']) near(frame[key], final[key], `${label} stable first visible frame ${key}`)
        if (h > 1) {
          const checkPosition = async () => {
            const { anchor: a, menu: m } = await geometry()
            const candidates = [
              { left: a.left, top: a.top - m.height - 6 }, { left: a.right - m.width, top: a.top - m.height - 6 },
              { left: a.left, top: a.bottom + 6 }, { left: a.right - m.width, top: a.bottom + 6 }
            ]
            const expected = candidates.find(p => p.left >= 6 && p.top >= 6 && p.left + m.width <= width - 6 && p.top + m.height <= 594)
            if (expected) {
              near(m.top, expected.top, `${label} preferred vertical side`)
              near(m.left, expected.left, `${label} preferred horizontal alignment`)
            }
            assert.ok(m.left >= 0 && m.top >= 0 && m.right <= width && m.bottom <= 600, `${label} within viewport`)
          }
          await checkPosition()
          if (w === 1) {
            await evaluate(`${root('positioned')}.querySelector('.widget-action-item:last-child').click()`)
            await wait(220)
            await checkPosition()
          }
        }
        await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")
        await wait(80)
      }
      // Open-menu geometry changes must also update JS positioning, even when
      // the anchor moves without changing its dimensions.
      await evaluate('fixture.storage.local_widgets$({positioned:{...fixture.menuRecord,row:4,col:1,desired:{w:1,h:1}}})')
      await wait(120)
      await select('positioned')
      await evaluate(`${root('positioned')}.querySelector('.widget-remove-button').click()`)
      await wait(220)
      await evaluate('fixture.storage.local_widgets$(records=>({...records,positioned:{...records.positioned,desired:{w:1,h:3}}}))')
      await wait(220)
      let g = await geometry()
      near(g.menu.bottom, g.anchor.top - 6, 'open menu switches to top preference')
      await evaluate('fixture.storage.local_widgets$(records=>({...records,positioned:{...records.positioned,row:3}}))')
      await wait(220)
      g = await geometry()
      near(g.menu.bottom, g.anchor.top - 6, 'open menu follows moved anchor')
      await evaluate("fixture.positionPersonas=fixture.storage.local_personas$();fixture.storage.local_personas$(Object.fromEntries(Array.from({length:20},(_,i)=>['large'+i,{userPks:['user','member'],createdAt:i}])) )")
      await evaluate(`${root('positioned')}.querySelector('.widget-action-item:last-child').click()`)
      await wait(220)
      for (const height of [600, 300]) {
        await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
        await wait(220)
        const { menu: m } = await geometry()
        assert.ok(m.left >= 0 && m.top >= 0 && m.right <= width && m.bottom <= height, `${fallback ? 'fallback' : 'anchors'} long selector stays inside ${width}x${height}: ${JSON.stringify(m)}`)
        assert.equal(await evaluate(`${root('positioned')}.querySelector('dialog').scrollHeight>${root('positioned')}.querySelector('dialog').clientHeight`), true, 'long selector scrolls internally')
      }
      await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")
      // Finish native popover focus restoration before removing its anchor
      // and starting the next independent viewport/fallback scenario.
      await wait(350)
      await evaluate('fixture.storage.local_personas$(fixture.positionPersonas)')
      await evaluate('fixture.storage.local_widgets$({})')
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 1, mobile: false })
      await wait(150)
      if (fallback) await evaluate('CSS.supports=originalSupports')
    }
  }
  console.log('Chrome widget menu positions passed: top controls, four placements, live geometry and resize hit areas')
}
