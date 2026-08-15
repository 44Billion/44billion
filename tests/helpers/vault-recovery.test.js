import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVaultRecoveryStore } from '../../src/components/zones/vault-modal/recovery-store.js'

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
  const store = createVaultRecoveryStore(key => `t:${key}`)
  store.currentRequest$ = signal(null)
  store.lastRequest$ = signal(null)
  return store
}

test('starts closed with localized fallback copy', () => {
  const store = createStore()
  assert.equal(store.isOpen$(), false)
  assert.equal(store.title$(), 't:Vault')
  assert.equal(store.message$(), 't:Vault failed to start. Retry?')
})

test('requestAction opens the dialog with the given copy and retry resolves', async () => {
  const store = createStore()
  const promise = store.requestAction({ title: 'Vault', message: 'Vault unreachable. Retry?' })
  assert.equal(store.isOpen$(), true)
  assert.equal(store.title$(), 'Vault')
  assert.equal(store.message$(), 'Vault unreachable. Retry?')
  store.resolveRetry()
  await assert.doesNotReject(promise)
  assert.equal(store.isOpen$(), false)
  assert.equal(store.title$(), 'Vault')
  assert.equal(store.message$(), 'Vault unreachable. Retry?')
})

test('a newer request supersedes the pending one', async () => {
  const store = createStore()
  const first = store.requestAction({ title: 'Vault', message: 'First' })
  const second = store.requestAction({ title: 'Vault', message: 'Second' })
  await assert.rejects(first, /superseded/)
  assert.equal(store.message$(), 'Second')
  store.rejectDismiss()
  await assert.rejects(second, /dismissed/)
})

test('dismiss rejects the pending request', async () => {
  const store = createStore()
  const promise = store.requestAction({ title: 'Vault', message: 'Vault failed to start. Retry?' })
  store.dismiss()
  await assert.rejects(promise, /superseded/)
  assert.equal(store.isOpen$(), false)
})

test('close (ESC/backdrop) retries instead of dismissing and keeps the last copy', async () => {
  const store = createStore()
  const promise = store.requestAction({ title: 'Vault', message: 'Vault failed to start. Retry?' })
  store.close()
  await assert.doesNotReject(promise)
  assert.equal(store.isOpen$(), false)
  assert.equal(store.title$(), 'Vault')
  assert.equal(store.message$(), 'Vault failed to start. Retry?')
})
