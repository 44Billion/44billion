import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  initTabWorkspaceOrder,
  readActiveWorkspaceOrder,
  validWorkspaceOrder,
  writeActiveWorkspaceOrder
} from '#helpers/active-workspace-order.js'

function storageMock (entries = {}) {
  const data = new Map(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]))
  return {
    getItem: key => data.get(String(key)) ?? null,
    setItem: (key, value) => data.set(String(key), String(value)),
    removeItem: key => data.delete(String(key)),
    _data: data
  }
}

describe('active workspace order', () => {
  it('falls back to the canonical localStorage order when the tab has none', () => {
    const local = storageMock({ session_openWorkspaceKeys: ['ws2', 'ws1'] })
    const tab = storageMock()

    assert.deepEqual(readActiveWorkspaceOrder(local, tab), ['ws2', 'ws1'])
    assert.deepEqual(initTabWorkspaceOrder({ localStorageArea: local, sessionStorageArea: tab }), ['ws2', 'ws1'])
    assert.deepEqual(JSON.parse(tab.getItem('session_tabWorkspaceKeys')), ['ws2', 'ws1'])
  })

  it('prefers the tab order and writes both storages on update', () => {
    const local = storageMock({ session_openWorkspaceKeys: ['ws1'] })
    const tab = storageMock({ session_tabWorkspaceKeys: ['ws2', 'ws1'] })

    assert.deepEqual(readActiveWorkspaceOrder(local, tab), ['ws2', 'ws1'])
    writeActiveWorkspaceOrder(local, tab, ['ws1', 'ws2'])
    assert.deepEqual(JSON.parse(local.getItem('session_openWorkspaceKeys')), ['ws1', 'ws2'])
    assert.deepEqual(JSON.parse(tab.getItem('session_tabWorkspaceKeys')), ['ws1', 'ws2'])
  })

  it('filters stale keys against the current workspace list', () => {
    assert.deepEqual(
      validWorkspaceOrder(['ws1', 'ghost'], ['ws1', 'ws2']),
      ['ws1']
    )
    assert.deepEqual(validWorkspaceOrder(null, ['ws1']), [])
  })
})
