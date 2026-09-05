import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWidgetDragSurface } from '../../src/helpers/widget-drag-surface.js'

function setup () {
  const window = new EventTarget()
  const events = []
  const captures = []
  let selected = true
  const target = {
    setPointerCapture: id => captures.push(id),
    releasePointerCapture: id => dispatch('lostpointercapture', { pointerId: id })
  }
  const surface = createWidgetDragSurface({
    window,
    canStart: () => selected,
    getCaptureTarget: () => target,
    onStart: (x, y) => events.push(['start', x, y]),
    onMove: (x, y) => events.push(['move', x, y]),
    onEnd: () => events.push(['end'])
  })
  function dispatch (type, extra = {}) {
    const event = new Event(type, { cancelable: true })
    Object.assign(event, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 50, clientY: 60, ...extra })
    if (type === 'pointerdown') surface.onPointerDown(event)
    else window.dispatchEvent(event)
    return event
  }
  return { dispatch, surface, events, captures, deselect: () => { selected = false } }
}

for (const pointerType of ['mouse', 'touch', 'pen']) {
  test(`${pointerType} captures in the launcher and releases once outside the widget`, () => {
    const h = setup()
    assert.equal(h.dispatch('pointerdown', { pointerType }).defaultPrevented, true)
    assert.deepEqual(h.captures, [1])
    h.dispatch('pointermove', { pointerType, clientY: -20 })
    assert.equal(h.dispatch('contextmenu').defaultPrevented, true)
    h.dispatch('pointerup', { pointerType, clientY: -20 })
    h.dispatch('pointerup', { pointerType })
    h.dispatch('lostpointercapture')
    assert.deepEqual(h.events, [['start', 50, 60], ['move', 50, -20], ['end']])
    h.dispatch('pointerdown', { pointerType })
    h.dispatch('pointerup', { pointerType })
    assert.equal(h.events.filter(e => e[0] === 'end').length, 2)
  })
}

for (const type of ['pointercancel', 'lostpointercapture', 'blur']) {
  test(`${type} ends the gesture once and removes listeners`, () => {
    const h = setup()
    h.dispatch('pointerdown')
    h.dispatch(type)
    h.dispatch('pointerup')
    h.dispatch('pointermove')
    assert.deepEqual(h.events, [['start', 50, 60], ['end']])
  })
}

test('cleanup for hide/unmount is idempotent and unrelated pointers cannot interfere', () => {
  const h = setup()
  h.dispatch('pointerdown')
  h.dispatch('pointerdown', { pointerId: 2 })
  h.dispatch('pointermove', { pointerId: 2 })
  h.dispatch('pointercancel', { pointerId: 2 })
  h.surface.release()
  h.surface.release()
  h.dispatch('pointerup')
  h.dispatch('pointermove')
  assert.deepEqual(h.events, [['start', 50, 60]])
})

test('released mouse buttons recover a missing pointerup; non-editing and secondary presses are untouched', () => {
  const h = setup()
  h.dispatch('pointerdown', { button: 2 })
  h.dispatch('pointerdown', { isPrimary: false })
  assert.deepEqual(h.events, [])
  h.dispatch('pointerdown')
  h.dispatch('pointermove', { buttons: 0 })
  assert.deepEqual(h.events, [['start', 50, 60], ['end']])
  h.deselect()
  assert.equal(h.dispatch('pointerdown').defaultPrevented, false)
})

test('native touch gestures are blocked only for the captured editing gesture', () => {
  const h = setup()
  assert.equal(h.dispatch('touchstart').defaultPrevented, false)
  h.dispatch('pointerdown', { pointerType: 'touch' })
  assert.equal(h.dispatch('touchstart').defaultPrevented, true)
  assert.equal(h.dispatch('touchmove').defaultPrevented, true)
  h.dispatch('pointerup', { pointerType: 'touch' })
  assert.equal(h.dispatch('touchstart').defaultPrevented, false)
  assert.equal(h.dispatch('touchmove').defaultPrevented, false)
  assert.equal(h.dispatch('contextmenu').defaultPrevented, false)
})
