import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  APP_BRIDGE_ERROR_KIND,
  isAppBridgeCommunicationError,
  isCriticalAppFile,
  normalizeAppBridgeError
} from '../../src/helpers/window-message/app-bridge-error.js'

describe('app bridge error classification', () => {
  it('treats bridge and app-page timeouts as communication errors', () => {
    assert.equal(isAppBridgeCommunicationError({
      pathname: undefined,
      kind: APP_BRIDGE_ERROR_KIND.BRIDGE
    }), true)
    assert.equal(isAppBridgeCommunicationError({
      pathname: 'index.html',
      kind: APP_BRIDGE_ERROR_KIND.APP_PAGE
    }), true)
  })

  it('keeps file errors as removable/critical candidates', () => {
    assert.equal(isAppBridgeCommunicationError({
      pathname: 'index.html',
      kind: APP_BRIDGE_ERROR_KIND.FILE
    }), false)
    assert.equal(isCriticalAppFile('index.html'), true)
    assert.equal(isCriticalAppFile('styles.css'), false)
  })

  it('normalizes legacy string errors as file errors', () => {
    const normalized = normalizeAppBridgeError('styles.css')

    assert.deepEqual(normalized, {
      pathname: 'styles.css',
      kind: APP_BRIDGE_ERROR_KIND.FILE
    })
  })
})
