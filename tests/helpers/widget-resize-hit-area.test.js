import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getWidgetResizeHitInsets } from '../../src/helpers/widget-resize-hit-area.js'

test('1x1 controls reserve their full interior against all four nodes', () => {
  assert.deepEqual(getWidgetResizeHitInsets({
    width: 40, height: 40, controls: [{ left: 7, top: 7, width: 26, height: 26 }]
  }), { top: 2, right: 2, bottom: 2, left: 2 })
})

test('a wide one-row widget only contracts the node next to its compact button', () => {
  assert.deepEqual(getWidgetResizeHitInsets({
    width: 160, height: 40, controls: [{ left: 128, top: 7, width: 26, height: 26 }]
  }), { top: -10, right: 3, bottom: -10, left: -10 })
})

test('a tall one-column widget protects remove and pin but leaves side nodes expanded', () => {
  assert.deepEqual(getWidgetResizeHitInsets({
    width: 40, height: 100,
    controls: [{ left: 7, top: 6, width: 26, height: 26 }, { left: 7, top: 68, width: 26, height: 26 }]
  }), { top: 3, right: -10, bottom: 3, left: -10 })
})

test('spacious widgets preserve the existing hit expansion', () => {
  assert.deepEqual(getWidgetResizeHitInsets({
    width: 160, height: 160,
    controls: [{ left: 128, top: 6, width: 26, height: 26 }, { left: 128, top: 128, width: 26, height: 26 }]
  }), { top: -10, right: -10, bottom: -10, left: -10 })
})
