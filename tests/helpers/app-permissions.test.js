import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createPermissionScopeRegistry } from '#helpers/window-message/browser/permission-scopes.js'
import {
  describeStoredPermission,
  groupPermissionsByApp,
  groupStoredPermissions,
  permissionRecordId
} from '#services/app-permissions.js'

const translate = key => ({
  'All app data': 'All app data',
  'All personal data': 'All personal data',
  'Encrypt or decrypt any data': 'Encrypt or decrypt any data'
}[key] ?? key)

const translateKind = key => ({
  profiles: 'profiles',
  'chat messages': 'chat messages',
  'calendar sync': 'Calendar sync',
  'file calendar sync': 'File calendar sync'
}[key] ?? key)

describe('app permission presentation', () => {
  it('groups grants by app and preserves each exact permission identity', () => {
    const permissions = [
      { appId: 'app-b', name: 'eventAccess', eKind: 1, scope: '' },
      { appId: 'app-a', name: 'eventAccessPersonal', eKind: 9, scope: 'calendar:v1' },
      { appId: 'app-a', name: 'eventAccessPersonal', eKind: 9, scope: 'photos:v1' }
    ]
    const groups = groupPermissionsByApp(permissions)
    assert.deepEqual(groups.map(group => [group.appId, group.permissions.length]), [
      ['app-b', 1],
      ['app-a', 2]
    ])
    assert.notEqual(
      permissionRecordId(permissions[1]),
      permissionRecordId(permissions[2])
    )
  })

  it('describes broad, personal, legacy encryption and scoped grants', () => {
    const registry = createPermissionScopeRegistry([
      { kind: 9, scope: 'calendar:v1', labelKey: 'calendar sync' },
      { kind: 1063, scope: 'calendar:v1', labelKey: 'file calendar sync' }
    ])
    const options = { translate, translateKind, scopeRegistry: registry }

    assert.deepEqual(
      describeStoredPermission({ appId: 'app', name: 'eventAccess', eKind: -1, scope: '' }, options),
      {
        id: permissionRecordId({ appId: 'app', name: 'eventAccess', eKind: -1, scope: '' }),
        permission: { appId: 'app', name: 'eventAccess', eKind: -1, scope: '' },
        sectionId: 'eventData',
        order: 0,
        title: 'All app data',
        broad: true,
        kind: -1,
        scopeLabel: ''
      }
    )
    assert.equal(
      describeStoredPermission({ appId: 'app', name: 'eventAccessPersonal', eKind: 9, scope: 'calendar:v1' }, options).scopeLabel,
      'Calendar sync'
    )
    assert.equal(
      describeStoredPermission({ appId: 'app', name: 'eventAccessPersonal', eKind: 1063, scope: 'calendar:v1' }, options).scopeLabel,
      'File calendar sync'
    )
    assert.equal(
      describeStoredPermission({ appId: 'app', name: 'eventAccessPersonal', eKind: 9, scope: 'zillion:*' }, options).scopeLabel,
      ''
    )
    assert.equal(
      describeStoredPermission({ appId: 'app', name: 'legacyCryptoAccess', eKind: -1, scope: '' }, options).sectionId,
      'encryption'
    )
  })

  it('orders permission groups and rows semantically', () => {
    const groups = groupStoredPermissions([
      { appId: 'app', name: 'legacyCryptoAccess', eKind: -1, scope: '' },
      { appId: 'app', name: 'eventAccess', eKind: 9, scope: '' },
      { appId: 'app', name: 'eventAccess', eKind: 1, scope: '' },
      { appId: 'app', name: 'eventAccessPersonal', eKind: 9, scope: '' }
    ], { translate, translateKind })
    assert.deepEqual(groups.map(group => group.id), ['eventData', 'personalCopies', 'encryption'])
    assert.deepEqual(groups[0].rows.map(row => row.kind), [1, 9])
  })
})
