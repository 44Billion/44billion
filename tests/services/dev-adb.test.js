import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatRemoteObject,
  shouldShowLevel,
  targetLabelForHost
} from '#bin/dev-adb.js'

describe('dev-adb console streaming helpers', () => {
  it('labels launcher, app and vault targets by host', () => {
    assert.equal(targetLabelForHost('localhost:10000'), 'launcher')
    assert.equal(targetLabelForHost('0.localhost:10000'), 'app:0')
    assert.equal(targetLabelForHost('12.localhost:10000'), 'app:12')
    assert.equal(targetLabelForHost('localhost:4000'), 'vault')
    assert.equal(targetLabelForHost('vault.localhost:4000'), 'vault')
    assert.equal(targetLabelForHost(''), 'unknown')
  })

  it('hides debug/trace levels unless debug is enabled', () => {
    assert.equal(shouldShowLevel('log', false), true)
    assert.equal(shouldShowLevel('warning', false), true)
    assert.equal(shouldShowLevel('error', false), true)
    assert.equal(shouldShowLevel('debug', false), false)
    assert.equal(shouldShowLevel('trace', false), false)
    assert.equal(shouldShowLevel('debug', true), true)
    assert.equal(shouldShowLevel('trace', true), true)
  })

  it('formats CDP remote objects into readable text', () => {
    assert.equal(formatRemoteObject({ type: 'string', value: 'hi' }), 'hi')
    assert.equal(formatRemoteObject({ type: 'number', value: 3 }), '3')
    assert.equal(formatRemoteObject({ type: 'undefined' }), 'undefined')
    assert.equal(
      formatRemoteObject({ type: 'object', description: 'Object {a: 1}' }),
      'Object {a: 1}'
    )
    assert.equal(
      formatRemoteObject({ type: 'object', preview: { description: 'Array(3)' } }),
      'Array(3)'
    )
    assert.equal(
      formatRemoteObject({
        type: 'object',
        preview: {
          description: 'Object',
          overflow: false,
          properties: [
            { name: 'reason', type: 'string', value: 'pointerend' },
            { name: 'wasActive', type: 'boolean', value: false }
          ]
        }
      }),
      '{reason: "pointerend", wasActive: false}'
    )
    assert.equal(
      formatRemoteObject({
        type: 'object',
        preview: {
          description: 'Object',
          overflow: true,
          properties: [{ name: 'a', type: 'number', value: 1 }]
        }
      }),
      '{a: 1, …}'
    )
    assert.equal(
      formatRemoteObject({
        type: 'object',
        subtype: 'array',
        preview: {
          description: 'Array(2)',
          overflow: false,
          properties: [
            { name: '0', type: 'number', value: 1 },
            { name: '1', type: 'number', value: 2 }
          ]
        }
      }),
      '[1, 2]'
    )
  })
})
