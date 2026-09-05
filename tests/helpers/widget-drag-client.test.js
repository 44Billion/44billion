import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWidgetDragClient } from '../../src/helpers/window-message/widget-drag-client.js'

function setup (t, { widget = true, reentrantRelease = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 })
  const attributes = new Set()
  const styles = []
  const originalStyle = { touchAction: 'pan-y', userSelect: 'text', webkitTouchCallout: 'default' }
  const root = {
    style: { ...originalStyle },
    toggleAttribute (name, enabled) {
      if (enabled) attributes.add(name)
      else attributes.delete(name)
    },
    appendChild (style) { styles.push(style) }
  }
  const window = new EventTarget()
  window.location = { hostname: 'widget.example' }
  const document = new EventTarget()
  document.documentElement = root
  document.body = { style: { ...originalStyle } }
  document.createElement = tag => {
    assert.equal(tag, 'style')
    return { textContent: '' }
  }
  document.visibilityState = 'visible'
  const registrations = []
  const addEventListener = window.addEventListener.bind(window)
  window.addEventListener = (type, listener, options) => {
    registrations.push({ type, options })
    addEventListener(type, listener, options)
  }
  const captured = []
  const released = []
  const target = {
    setPointerCapture (id) { captured.push(id) },
    releasePointerCapture (id) {
      released.push(id)
      if (reentrantRelease) dispatch('lostpointercapture', { pointerId: id })
    }
  }
  const messages = []
  const client = createWidgetDragClient({
    window,
    document,
    isWidget: () => widget,
    sendDrag: (...args) => messages.push(args)
  })
  function dispatch (type, overrides = {}, emitter = window) {
    const event = new Event(type, { cancelable: true })
    const properties = {
      pointerId: 1, pointerType: 'touch', target,
      clientX: 20, clientY: 30, screenX: 120, screenY: 130,
      detail: 1, ...overrides
    }
    for (const [key, value] of Object.entries(properties)) {
      Object.defineProperty(event, key, { value })
    }
    emitter.dispatchEvent(event)
    return event
  }
  return {
    client, dispatch, messages, window, document, target, root, styles,
    captured, released, registrations, originalStyle,
    touchLocked: () => attributes.has('data-launcher-widget-touch-lock'),
    selectionLocked: () => attributes.has('data-launcher-widget-selection-lock')
  }
}

test('selection prelocks the iframe and nested scrollers without overwriting app styles', t => {
  const h = setup(t)
  assert.equal(h.touchLocked(), false)
  h.client.setSelectMode(true)
  assert.equal(h.touchLocked(), true)
  assert.equal(h.selectionLocked(), true)
  assert.match(h.styles[0].textContent, /html\[data-launcher-widget-touch-lock\] \*\s*\{\s*touch-action: none !important/)
  assert.match(h.styles[0].textContent, /html\[data-launcher-widget-selection-lock\] \*/)
  assert.match(h.styles[0].textContent, /-webkit-touch-callout: none !important/)
  assert.deepEqual(h.root.style, h.originalStyle)
  h.client.setSelectMode(false)
  assert.equal(h.touchLocked(), false)
  assert.equal(h.selectionLocked(), false)
  assert.deepEqual(h.document.body.style, h.originalStyle)
  assert.deepEqual(h.root.style, h.originalStyle)
  // Fresh selection, expiry, and repeated bridge messages share this path.
  h.client.setSelectMode(true)
  h.client.setSelectMode(true)
  assert.equal(h.touchLocked(), true)
  assert.equal(h.styles.length, 1)
  h.client.setSelectMode(false)
  assert.equal(h.touchLocked(), false)
})

test('selected presses own native touchstart and stay active while held still', t => {
  const h = setup(t)
  const appEvents = []
  for (const type of ['pointerdown', 'touchstart', 'contextmenu', 'selectstart', 'dragstart']) {
    h.window.addEventListener(type, () => appEvents.push(type))
  }
  h.client.setSelectMode(true)
  assert.equal(h.dispatch('pointerdown').defaultPrevented, true)
  assert.equal(h.dispatch('touchstart').defaultPrevented, true)
  assert.deepEqual(h.messages, [['start', 20, 30, 120, 130]])
  t.mock.timers.tick(1200)
  for (const type of ['contextmenu', 'selectstart', 'dragstart']) {
    assert.equal(h.dispatch(type).defaultPrevented, true)
  }
  assert.deepEqual(appEvents, [])
  assert.equal(h.messages.length, 1)
  assert.deepEqual(h.captured, [1])
  assert.deepEqual(h.registrations.find(r => r.type === 'touchstart').options,
    { capture: true, passive: false })
  assert.equal(h.dispatch('pointermove', { clientY: 70, screenY: 170 }).defaultPrevented, true)
  assert.deepEqual(h.messages.at(-1), ['move', 20, 70, 120, 170])
  h.dispatch('pointerup')
  assert.deepEqual(h.messages.at(-1), ['end', 20, 70])
  assert.equal(h.touchLocked(), true)
})

test('longpress, release, immediate movement and another stationary press form separate drags', t => {
  const h = setup(t)
  h.dispatch('pointerdown')
  assert.equal(h.selectionLocked(), true)
  assert.equal(h.touchLocked(), false)
  t.mock.timers.tick(599)
  assert.equal(h.messages.length, 0)
  t.mock.timers.tick(1)
  assert.equal(h.messages[0][0], 'start')
  assert.equal(h.touchLocked(), true)
  h.dispatch('pointerup')
  // The launcher selects the widget after receiving the first drag's end.
  h.client.setSelectMode(true)
  h.dispatch('pointerdown', { pointerId: 2 })
  h.dispatch('touchstart')
  h.dispatch('pointermove', { pointerId: 2, clientX: 80, screenX: 180 })
  assert.equal(h.dispatch('touchmove').defaultPrevented, true)
  h.dispatch('pointerup', { pointerId: 2 })
  assert.equal(h.touchLocked(), true)
  h.dispatch('pointerdown', { pointerId: 3 })
  t.mock.timers.tick(1000)
  h.dispatch('contextmenu')
  h.dispatch('pointerup', { pointerId: 3 })
  assert.deepEqual(h.messages.map(m => m[0]), ['start', 'end', 'start', 'move', 'end', 'start', 'end'])
})

test('deselection during a drag waits for its end, then allows ordinary app taps', t => {
  const h = setup(t)
  const appClicks = []
  h.window.addEventListener('click', () => appClicks.push('click'))
  h.client.setSelectMode(true)
  h.dispatch('pointerdown')
  h.client.setSelectMode(false)
  assert.equal(h.touchLocked(), true)
  h.dispatch('pointerup')
  assert.equal(h.touchLocked(), false)
  assert.equal(h.selectionLocked(), false)
  assert.equal(h.dispatch('touchend').defaultPrevented, true)
  assert.equal(h.dispatch('click').defaultPrevented, true)
  assert.deepEqual(appClicks, [])
  assert.equal(h.dispatch('click', { detail: 0 }).defaultPrevented, false)
  assert.equal(h.dispatch('pointerdown', { pointerId: 2 }).defaultPrevented, false)
  assert.equal(h.dispatch('touchstart').defaultPrevented, false)
  h.dispatch('pointerup', { pointerId: 2 })
  assert.equal(h.dispatch('touchend').defaultPrevented, false)
  assert.equal(h.dispatch('click').defaultPrevented, false)
  assert.deepEqual(appClicks, ['click', 'click'])
})

for (const type of ['touch', 'pen', 'mouse']) {
  test(`${type} taps and movement before longpress leave app gestures available`, t => {
    const h = setup(t)
    const appEvents = []
    h.window.addEventListener('pointermove', () => appEvents.push('move'))
    h.dispatch('pointerdown', { pointerType: type })
    assert.equal(h.dispatch('touchstart').defaultPrevented, false)
    assert.equal(h.dispatch('pointermove', { clientY: 41 }).defaultPrevented, false)
    assert.equal(h.dispatch('touchmove').defaultPrevented, false)
    t.mock.timers.tick(1000)
    assert.deepEqual(h.messages, [])
    assert.deepEqual(h.captured, [])
    assert.deepEqual(appEvents, ['move'])
    assert.equal(h.touchLocked(), false)
    h.dispatch('pointerup')
    assert.equal(h.selectionLocked(), false)
    h.dispatch('pointerdown', { pointerId: 2, pointerType: type })
    h.dispatch('pointerup', { pointerId: 2 })
    t.mock.timers.tick(1000)
    assert.deepEqual(h.messages, [])
  })
}

test('mouse selection still starts and moves immediately without claiming app pointer capture', t => {
  const h = setup(t)
  h.client.setSelectMode(true)
  h.dispatch('pointerdown', { pointerType: 'mouse' })
  h.dispatch('pointermove', { pointerType: 'mouse', clientX: 40 })
  h.dispatch('pointerup', { pointerType: 'mouse' })
  assert.deepEqual(h.messages.map(m => m[0]), ['start', 'move', 'end'])
  assert.deepEqual(h.captured, [])
})

for (const ending of ['pointercancel', 'touchcancel', 'lostpointercapture', 'blur', 'pagehide', 'visibilitychange']) {
  test(`${ending} ends once and permits the next selected press`, t => {
    const h = setup(t, { reentrantRelease: true })
    h.client.setSelectMode(true)
    h.dispatch('pointerdown')
    if (ending === 'visibilitychange') {
      h.document.visibilityState = 'hidden'
      h.dispatch(ending, {}, h.document)
    } else h.dispatch(ending)
    h.dispatch('pointerup')
    h.dispatch('touchcancel')
    h.dispatch('lostpointercapture')
    assert.deepEqual(h.messages.map(m => m[0]), ['start', 'end'])
    assert.deepEqual(h.released, [1])
    assert.equal(h.touchLocked(), true)
    h.document.visibilityState = 'visible'
    h.dispatch('pointerdown', { pointerId: 2 })
    h.dispatch('pointerup', { pointerId: 2 })
    assert.deepEqual(h.messages.map(m => m[0]), ['start', 'end', 'start', 'end'])
  })
}

test('an unrelated pointer cannot move or end the active drag', t => {
  const h = setup(t)
  h.client.setSelectMode(true)
  h.dispatch('pointerdown')
  h.dispatch('pointerdown', { pointerId: 2 })
  h.dispatch('pointermove', { pointerId: 2, clientX: 50 })
  h.dispatch('pointerup', { pointerId: 2 })
  h.dispatch('lostpointercapture', { pointerId: 2 })
  assert.equal(h.messages.length, 1)
  h.dispatch('pointerup')
  assert.equal(h.messages.at(-1)[0], 'end')
})

test('a new pointer recovers a stale stream and cancelled pending presses never activate', t => {
  const h = setup(t)
  h.dispatch('pointerdown')
  h.dispatch('pointercancel')
  t.mock.timers.tick(1000)
  assert.deepEqual(h.messages, [])
  assert.equal(h.selectionLocked(), false)
  h.client.setSelectMode(true)
  h.dispatch('pointerdown', { pointerId: 2 })
  t.mock.timers.tick(2001)
  h.dispatch('pointerdown', { pointerId: 3 })
  h.dispatch('pointerup', { pointerId: 3 })
  assert.deepEqual(h.messages.map(m => m[0]), ['start', 'end', 'start', 'end'])
})

test('regular app windows are unaffected even by a selection message', t => {
  const h = setup(t, { widget: false })
  h.client.setSelectMode(true)
  for (const type of ['pointerdown', 'touchstart', 'pointermove', 'touchmove', 'contextmenu', 'pointerup', 'click']) {
    assert.equal(h.dispatch(type).defaultPrevented, false)
  }
  t.mock.timers.tick(1000)
  assert.deepEqual(h.messages, [])
  assert.equal(h.touchLocked(), false)
  assert.equal(h.selectionLocked(), false)
  assert.equal(h.styles.length, 0)
})
