import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWidgetPageScroll } from '../../src/helpers/widget-page-scroll.js'

function setup ({ reducedMotion = false, snap = '', priority = '' } = {}) {
  const frames = new Map()
  const positions = []
  const finished = []
  let id = 0
  const view = {
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame: tick => { frames.set(++id, tick); return id },
    cancelAnimationFrame: id => frames.delete(id)
  }
  const el = {
    ownerDocument: { defaultView: view },
    isConnected: true,
    scrollLeft: 0,
    scrollWidth: 2400,
    clientWidth: 800,
    scrollTo ({ left, behavior }) {
      assert.equal(behavior, 'instant')
      this.scrollLeft = left
      positions.push(left)
    },
    style: {
      getPropertyValue: () => snap,
      getPropertyPriority: () => priority,
      setProperty: (name, value, nextPriority = '') => { snap = value; priority = nextPriority },
      removeProperty: () => { snap = ''; priority = '' }
    }
  }
  const scroller = createWidgetPageScroll()
  const start = page => scroller.scrollTo(el, { page, left: page * 800, onFinish: () => finished.push(page) })
  const tick = now => {
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach(callback => callback(now))
  }
  return { el, scroller, start, tick, frames, positions, finished }
}

test('animation traverses the page and restores pre-existing snap style and priority', () => {
  const h = setup({ snap: 'x proximity', priority: 'important' })
  h.start(1)
  assert.equal(h.el.style.getPropertyValue(), 'none')
  for (const now of [0, 100, 200, 300, 400]) h.tick(now)
  assert.deepEqual(h.positions, [0, 50, 400, 750, 800])
  assert.deepEqual(h.finished, [1])
  assert.equal(h.scroller.active, false)
  assert.equal(h.el.style.getPropertyValue(), 'x proximity')
  assert.equal(h.el.style.getPropertyPriority(), 'important')
})

test('retargeting starts at the current position and does not complete the old navigation', () => {
  const h = setup()
  h.start(1)
  h.tick(0)
  h.tick(200)
  h.start(2)
  h.tick(210)
  assert.equal(h.el.scrollLeft, 400)
  h.tick(610)
  assert.deepEqual(h.finished, [2])
  assert.equal(h.el.scrollLeft, 1600)
  assert.equal(h.el.style.getPropertyValue(), '')
})

for (const reason of ['cancel', 'disconnect']) {
  test(`${reason} stops frames without completing navigation and restores native snapping`, () => {
    const h = setup()
    h.start(1)
    h.tick(0)
    h.tick(100)
    if (reason === 'cancel') h.scroller.cancel()
    else h.el.isConnected = false
    h.tick(200)
    assert.equal(h.frames.size, 0)
    assert.equal(h.scroller.active, false)
    assert.equal(h.el.style.getPropertyValue(), '')
    assert.deepEqual(h.finished, [])
    assert.equal(h.el.scrollLeft, 50)
  })
}

test('reduced motion lands in one frame and a shrinking layout clamps the destination', () => {
  const h = setup({ reducedMotion: true })
  h.start(2)
  h.el.scrollWidth = 1600
  h.tick(0)
  assert.deepEqual(h.positions, [800])
  assert.deepEqual(h.finished, [2])
  assert.equal(h.scroller.active, false)
  assert.equal(h.el.style.getPropertyValue(), '')
})
