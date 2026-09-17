import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInfoDialogStore } from '../../src/components/zones/info-dialog/store.js'

function signal (initial) {
  let value = initial
  return function (next) {
    if (arguments.length > 0) {
      value = next
      return value
    }
    return value
  }
}

function createStore () {
  const store = createInfoDialogStore()
  store.current$ = signal(null)
  store.title$ = signal('')
  store.message$ = signal('')
  return store
}

test('starts closed without copy', () => {
  const store = createStore()
  assert.equal(store.isOpen$(), false)
  assert.equal(store.title$(), '')
  assert.equal(store.message$(), '')
})

test('showInfo opens the dialog with the given copy', () => {
  const store = createStore()
  store.showInfo({ title: 'Development reset', message: 'Could not clear the vault.' })
  assert.equal(store.isOpen$(), true)
  assert.equal(store.title$(), 'Development reset')
  assert.equal(store.message$(), 'Could not clear the vault.')
})

test('a newer message replaces the open one', () => {
  const store = createStore()
  store.showInfo({ title: 'Development reset', message: 'First' })
  store.showInfo({ title: 'Development reset', message: 'Second' })
  assert.equal(store.isOpen$(), true)
  assert.equal(store.message$(), 'Second')
})

test('closing keeps the last copy for the closing transition', () => {
  const store = createStore()
  store.showInfo({ title: 'Development reset', message: 'Could not clear the vault.' })
  store.close()
  assert.equal(store.isOpen$(), false)
  assert.equal(store.title$(), 'Development reset')
  assert.equal(store.message$(), 'Could not clear the vault.')
})
