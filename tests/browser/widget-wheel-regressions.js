import assert from 'node:assert/strict'

export default async function checkWheel ({ evaluate, cdp, wait }) {
  await evaluate('fixture.storage.local_widgets$(all=>({...all,far:{...all.tiny,col:36,row:0,isPinned:true}}))')
  await wait(200)
  const step = await evaluate("document.querySelectorAll('.widgets-page-snap')[1].offsetLeft")
  const left = () => evaluate("document.getElementById('widgets-scroll').scrollLeft")
  const expectPage = async (page, message) => {
    assert.ok(Math.abs(await left() - page * step) < 1, message)
  }
  const wheel = (deltaY = 100, deltaX = 0) => cdp('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 650, y: 400, deltaX, deltaY
  })
  const reset = async () => {
    await evaluate("document.getElementById('widgets-scroll').scrollTo({left:0,behavior:'instant'})")
    await wait(250)
  }

  // Reproduce a browser cancelling native smooth scrolling while wheel ticks
  // keep arriving. Check the path as well as the destination: a final instant
  // recovery would pass an arrival-only test while visibly teleporting.
  await evaluate(`(() => {
    const el = document.getElementById('widgets-scroll')
    window.wheelMotion = [el.scrollLeft]
    window.recordWheelMotion = () => wheelMotion.push(el.scrollLeft)
    el.addEventListener('scroll', recordWheelMotion)
    window.originalWheelScrollTo = el.scrollTo
    el.scrollTo = function (options) {
      originalWheelScrollTo.call(this, options)
      if (options.behavior === 'smooth') {
        setTimeout(() => originalWheelScrollTo.call(this, {left:this.scrollLeft,behavior:'instant'}), 50)
      }
    }
  })()`)

  // A continuous gesture can outlast the animation. Its remaining wheel
  // events must not start another page transition, including past halfway.
  for (let i = 0; i < 10; i++) {
    await wheel()
    await wait(70)
  }
  await wait(750)
  await expectPage(1, 'one wheel gesture advances exactly one page')
  const samples = await evaluate(`(() => {
    const el = document.getElementById('widgets-scroll')
    el.removeEventListener('scroll', recordWheelMotion)
    el.scrollTo = originalWheelScrollTo
    return wheelMotion
  })()`)
  assert.ok(samples.some(x => x > step * 0.2 && x < step * 0.8), 'wheel navigation includes intermediate animation frames')
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i] >= samples[i - 1] - 1, 'wheel navigation does not snap back mid-animation')
    assert.ok(samples[i] - samples[i - 1] < step * 0.5, 'wheel navigation does not jump to the destination')
  }
  assert.equal(await evaluate("getComputedStyle(document.getElementById('widgets-scroll')).scrollSnapType"), 'x mandatory', 'native snapping is restored after arrival')
  await wheel()
  await wait(750)
  await expectPage(2, 'a new wheel gesture advances again')
  await wheel(-100)
  await wait(750)
  await expectPage(1, 'reverse wheel navigation reaches the previous page')
  await wheel(0, -100)
  await wait(750)
  await expectPage(0, 'horizontal wheel navigation reaches the previous page')
  await wheel(-100)
  await wait(250)
  await expectPage(0, 'wheel navigation clamps at the first page')

  // Simulate native cancellation and snap-back before crossing the midpoint.
  await wheel()
  await wait(40)
  await evaluate("document.getElementById('widgets-scroll').scrollTo({left:0,behavior:'instant'})")
  await wait(750)
  await expectPage(1, 'an interrupted smooth scroll still reaches its destination')
  await wheel()
  await wait(750)
  await expectPage(2, 'interruption recovery releases the navigation lock')

  await reset()
  // An animation may be aborted before any scroll/scrollend notification.
  await evaluate(`(() => {
    const el = document.getElementById('widgets-scroll')
    const original = el.scrollTo
    el.scrollTo = function () { this.scrollTo = original }
  })()`)
  await wheel()
  await wait(750)
  await expectPage(1, 'navigation recovers even without an initial scroll event')

  await reset()
  await wheel()
  await wait(40)
  await evaluate(`(() => {
    const el = document.getElementById('widgets-scroll')
    el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }))
    el.scrollTo({left:0,behavior:'instant'})
  })()`)
  await wait(750)
  await expectPage(0, 'direct touch input cancels automatic recovery')
  await wheel()
  await wait(750)
  await expectPage(1, 'wheel navigation resumes after direct input')

  await reset()
  await evaluate("document.querySelectorAll('.widget-page-dot')[2].click()")
  await wait(750)
  await expectPage(2, 'dot navigation still reaches its destination')
  assert.deepEqual(await evaluate('fixtureErrors'), [])
  console.log('Widget wheel: gesture grouping, both axes/directions, bounds, interrupted/no-event recovery, touch takeover and dots passed')
}
