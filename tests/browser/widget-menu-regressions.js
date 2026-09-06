import assert from 'node:assert/strict'

export default async ({ cdp, evaluate, wait, root, select }) => {
  const results = []
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
              const text=item.querySelector('span:last-child');
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
      results.push({ viewportWidth, fallback, w, col, row, frames })
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
    assert.equal(final.items.length, 2, `${label}: both actions are rendered`)
    assert.ok(final.items.every(item => item.lines === 1 && Math.abs(item.iconWidth - 16) < 0.1), `${label}: labels and icons keep their natural size: ${JSON.stringify(final)}`)
    assert.ok(frames.every(frame => ['x', 'y', 'width', 'height'].every(key => Math.abs(frame[key] - final[key]) < 0.1)), `${label}: first visible frame already has the final geometry: ${JSON.stringify(frames)}`)
    assert.ok(final.x >= 0 && final.y >= 0 && final.x + final.width <= viewportWidth && final.y + final.height <= 600, `${label}: fits viewport`)
  }
  assert.deepEqual(await evaluate('fixtureErrors'), [])
  console.log('Chrome widget menus passed: natural width and stable first visible position, with CSS anchors and fallback')
}
