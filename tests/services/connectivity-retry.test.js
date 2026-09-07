import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConnectivityRetryCoordinator } from '#services/connectivity-retry.js'

describe('connectivity retry coordinator', () => {
  it('shares one online listener and wakes every waiter immediately', async () => {
    let onlineHandler
    let listenerCount = 0
    let removed = 0
    const coordinator = new ConnectivityRetryCoordinator({
      _isOnline: async () => false,
      _onOnline: handler => {
        onlineHandler = handler
        listenerCount++
        return () => { removed++ }
      }
    })

    const first = coordinator.waitUntilOnline()
    const second = coordinator.waitUntilOnline()
    assert.equal(listenerCount, 1)

    onlineHandler()
    await Promise.all([first, second])
    assert.equal(removed, 1)
  })

  it('stops monitoring when the final waiter is cancelled', async () => {
    let removed = 0
    const coordinator = new ConnectivityRetryCoordinator({
      _onOnline: () => () => { removed++ }
    })
    const controller = new AbortController()
    const waiting = coordinator.waitUntilOnline({ signal: controller.signal })
    controller.abort()
    await assert.rejects(waiting, { name: 'AbortError' })
    assert.equal(removed, 1)
  })

  it('limits resumed work to three concurrent tasks', async () => {
    const coordinator = new ConnectivityRetryCoordinator()
    const releases = []
    let active = 0
    let maximum = 0
    const tasks = Array.from({ length: 5 }, () => coordinator.run(async () => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise(resolve => releases.push(resolve))
      active--
    }))

    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(maximum, 3)
    releases.splice(0, 3).forEach(resolve => resolve())
    await new Promise(resolve => setTimeout(resolve, 0))
    releases.splice(0).forEach(resolve => resolve())
    await Promise.all(tasks)
    assert.equal(maximum, 3)
  })

  it('cancels an individual waiter without affecting the others', async () => {
    let onlineHandler
    const coordinator = new ConnectivityRetryCoordinator({
      _onOnline: handler => {
        onlineHandler = handler
        return () => {}
      },
      _setTimeout: () => 1,
      _clearTimeout: () => {}
    })
    const controller = new AbortController()
    const cancelled = coordinator.waitUntilOnline({ signal: controller.signal })
    const surviving = coordinator.waitUntilOnline()
    controller.abort()
    await assert.rejects(cancelled, { name: 'AbortError' })
    onlineHandler()
    await surviving
  })
})
