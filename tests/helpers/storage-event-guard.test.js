import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installStorageEventGuard } from '../../src/helpers/storage-event-guard.js'

test('discarding superseded storage events prevents cross-tab write-back loops', () => {
  const values = new Map([['name', 'Old']])
  const pending = []
  let writes = 0
  const tabs = [0, 1].map(() => {
    const listeners = []
    return {
      addEventListener: (_type, fn, options) => options?.capture ? listeners.unshift(fn) : listeners.push(fn),
      removeEventListener: (_type, fn) => listeners.splice(listeners.indexOf(fn), 1),
      dispatch (event) {
        let stopped = false
        event.stopImmediatePropagation = () => { stopped = true }
        for (const listener of listeners) { listener(event); if (stopped) break }
      }
    }
  })
  const storageArea = { getItem: key => values.get(key) ?? null }
  const write = (source, key, value) => {
    if (storageArea.getItem(key) === value) return
    writes++
    values.set(key, value)
    tabs.forEach((tab, index) => { if (index !== source) pending.push(() => tab.dispatch({ key, newValue: value, storageArea })) })
  }
  const observed = []
  tabs.forEach((tab, index) => {
    installStorageEventGuard(tab)
    tab.addEventListener('storage', event => { observed.push(event.newValue); write(index, event.key, event.newValue) })
  })
  write(0, 'name', null)
  write(0, 'name', 'New')
  for (let step = 0; pending.length && step < 10; step++) pending.shift()()
  assert.equal(pending.length, 0, 'event delivery must settle without echoing stale writes')
  assert.equal(writes, 2)
  assert.deepEqual(observed, ['New'])
  assert.equal(storageArea.getItem('name'), 'New')
})
