import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWidgetEditing } from '../../src/helpers/widget-editing.js'

function fixture () {
  let reveal = null
  let now = 0
  let seq = 0
  const timers = new Map()
  const make = widgetKey => {
    const state = { selected: false, menu: false }
    const controller = createWidgetEditing({
      widgetKey,
      readReveal: () => reveal,
      writeReveal: value => { reveal = value },
      onSelected: value => { state.selected = value },
      onMenu: value => { state.menu = value },
      schedule: (callback, delay) => { const id = ++seq; timers.set(id, { callback, at: now + delay }); return id },
      cancel: id => timers.delete(id)
    })
    return { ...controller, state }
  }
  return {
    make,
    reveal: () => reveal,
    tick (ms) {
      now += ms
      for (const [id, timer] of timers) {
        if (timer.at <= now) { timers.delete(id); timer.callback() }
      }
    }
  }
}

test('automatic reveal lasts through drag, resize and unpin until selection expires', () => {
  const f = fixture()
  const widget = f.make('pin')
  widget.begin({ wsKey: 'ws', isPinned: true, isObstructed: true })
  f.tick(10000)
  assert.deepEqual(f.reveal(), { widgetKey: 'pin', wsKey: 'ws' })
  widget.select()
  f.tick(3999)
  assert.equal(widget.state.selected, true)
  widget.pause() // resize
  f.tick(10000)
  widget.select()
  widget.begin({ wsKey: 'ws', isPinned: false, isObstructed: false })
  widget.select()
  f.tick(4000)
  assert.equal(widget.state.selected, false)
  assert.equal(f.reveal(), null)
})

test('menu suspends selection expiry and closing grants four new seconds', () => {
  const f = fixture()
  const widget = f.make('pin')
  widget.select()
  f.tick(3999)
  widget.setMenuOpen(true)
  f.tick(20000)
  assert.deepEqual(widget.state, { selected: true, menu: true })
  widget.select() // toggling pin from the open menu must not start its timer
  f.tick(20000)
  assert.equal(widget.state.selected, true)
  widget.setMenuOpen(false)
  f.tick(3999)
  assert.equal(widget.state.selected, true)
  f.tick(1)
  assert.deepEqual(widget.state, { selected: false, menu: false })
  widget.setMenuOpen(true)
  assert.equal(widget.state.menu, false)
})

test('transferring editing survives the old owner cleanup and timer', () => {
  const f = fixture()
  const first = f.make('first')
  const second = f.make('second')
  first.begin({ wsKey: 'ws', isPinned: true, isObstructed: true })
  first.select()
  second.begin({ wsKey: 'ws', isPinned: false, isObstructed: false })
  first.deselect()
  first.deselect()
  f.tick(10000)
  assert.equal(f.reveal().widgetKey, 'second')
  second.select()
  second.setMenuOpen(true)
  second.deselect() // visibility/pagehide/unmount/removal use this same cleanup
  assert.equal(f.reveal(), null)
  assert.deepEqual(second.state, { selected: false, menu: false })
})

test('late menu dismissal during resize does not restart selection expiry mid-gesture', () => {
  const f = fixture()
  const widget = f.make('widget')
  widget.select()
  widget.setMenuOpen(true)
  widget.pause() // resize pointerdown precedes native popover light-dismiss
  widget.setMenuOpen(false)
  f.tick(10000)
  assert.equal(widget.state.selected, true)
  widget.select() // resize ends
  f.tick(4000)
  assert.equal(widget.state.selected, false)
})

test('unobstructed pins and ordinary widgets do not claim automatic reveal', () => {
  const f = fixture()
  const widget = f.make('widget')
  widget.begin({ wsKey: 'ws', isPinned: true, isObstructed: false })
  assert.equal(f.reveal(), null)
  widget.begin({ wsKey: 'ws', isPinned: false, isObstructed: true })
  assert.equal(f.reveal(), null)
})
