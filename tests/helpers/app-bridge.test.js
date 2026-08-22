import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  disposeAppBridge,
  ensureAppBridgeState,
  getAppBridgeSpecs,
  registerAppBridgeSignalFactory,
  registerAppBridgeWindow
} from '../../src/helpers/window-message/app-bridge-registry.js'

function signalFactory (initialValue) {
  let value = initialValue
  const signal = (...args) => {
    if (args.length === 0) return value
    value = args[0]
    return value
  }
  signal.set = next => { value = next; return value }
  return signal
}

registerAppBridgeSignalFactory(signalFactory)

describe('app bridge registry', () => {
  it('keeps one bridge state per numeric subdomain', () => {
    const userPk = 'user'
    const appId = 'app'
    const first = ensureAppBridgeState('42', { userPk, appId })
    const second = ensureAppBridgeState('42', { userPk, appId })
    assert.equal(first, second)
  })

  it('replaces a disposed bridge when the numeric subdomain is reused', () => {
    const oldState = ensureAppBridgeState('44', { userPk: 'user-a', appId: 'app' })
    const unregister = registerAppBridgeWindow(oldState, { appKey: 'a', cachingProgress$: () => {} })
    unregister()
    disposeAppBridge(oldState)
    const newState = ensureAppBridgeState('44', { userPk: 'user-b', appId: 'other' })
    assert.notEqual(newState, oldState)
    disposeAppBridge(newState)
  })

  it('does not return another app/user bridge while windows are active', () => {
    const state = ensureAppBridgeState('45', { userPk: 'user-a', appId: 'app' })
    const unregister = registerAppBridgeWindow(state, { appKey: 'a', cachingProgress$: () => {} })

    assert.throws(
      () => ensureAppBridgeState('45', { userPk: 'user-b', appId: 'other' }),
      /belongs to another app\/user/
    )

    unregister()
    disposeAppBridge(state)
  })

  it('shares one bridge while more than one window is registered', () => {
    const state = ensureAppBridgeState('43', { userPk: 'user', appId: 'app' })
    const unregisterA = registerAppBridgeWindow(state, { appKey: 'a', cachingProgress$: () => {} })
    const unregisterB = registerAppBridgeWindow(state, { appKey: 'b', cachingProgress$: () => {} })
    assert.equal(getAppBridgeSpecs()().length, 1)
    unregisterA()
    assert.equal(getAppBridgeSpecs()().length, 1)
    unregisterB()
    disposeAppBridge(state)
    assert.equal(getAppBridgeSpecs()().length, 0)
  })

  it('keeps distinct single-napp window keys for the same app and user', () => {
    const state = ensureAppBridgeState('46', { userPk: 'user', appId: 'app' })
    const unregisterA = registerAppBridgeWindow(state, {
      appKey: 'single-napp:app:user:window-a',
      cachingProgress$: () => {}
    })
    const unregisterB = registerAppBridgeWindow(state, {
      appKey: 'single-napp:app:user:window-b',
      cachingProgress$: () => {}
    })

    assert.equal(state.windows.size, 2)

    unregisterA()
    unregisterB()
    disposeAppBridge(state)
  })
})
