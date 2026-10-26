import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createPermissionScopeRegistry,
  resolvedPermissionScope
} from '#helpers/window-message/browser/permission-scopes.js'

describe('permission scope registry', () => {
  const registry = createPermissionScopeRegistry([
    { kind: 9, scope: 'calendar:v1', labelKey: 'calendar sync' },
    { kind: 1063, scope: 'calendar:v1', labelKey: 'file calendar sync' }
  ])

  it('resolves the same scope differently by kind', () => {
    assert.deepEqual(resolvedPermissionScope(9, 'calendar:v1', registry), {
      scope: 'calendar:v1',
      labelKey: 'calendar sync'
    })
    assert.deepEqual(resolvedPermissionScope(1063, 'calendar:v1', registry), {
      scope: 'calendar:v1',
      labelKey: 'file calendar sync'
    })
    assert.deepEqual(resolvedPermissionScope(1, 'calendar:v1', registry), {
      scope: '',
      labelKey: null
    })
  })

  it('treats empty and unknown scopes as kind-wide without trimming', () => {
    assert.deepEqual(resolvedPermissionScope(9, '', registry), { scope: '', labelKey: null })
    assert.deepEqual(resolvedPermissionScope(9, ' calendar:v1 ', registry), { scope: '', labelKey: null })
    assert.deepEqual(resolvedPermissionScope(9, 'unknown', registry), { scope: '', labelKey: null })
    assert.throws(() => resolvedPermissionScope(9, 1, registry), error => error.code === 'INVALID_SCOPE')
  })
})
