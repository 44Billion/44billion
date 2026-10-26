import { permissionNamesForLookup } from '#helpers/window-message/browser/event-permissions.js'
import {
  permissionScopeEntry,
  SUPPORTED_PERMISSION_SCOPES
} from '#helpers/window-message/browser/permission-scopes.js'
import { run } from '#services/idb/browser/index.js'

function assertPermissionKey (appId, name, eKind, scope) {
  if (!appId || !name || eKind == null || typeof scope !== 'string') {
    throw new Error('appId, name, eKind and scope are required')
  }
}

async function hasPermissionForName (appId, name, eKind, scope) {
  return run('get', [[appId, name, eKind, scope]], 'permissions').then(value => !!value.result)
}

function permissionKey (permission) {
  return [permission.appId, permission.name, permission.eKind, permission.scope]
}

async function deleteStoredPermission (permission) {
  return run('delete', [permissionKey(permission)], 'permissions')
}

export async function hasPermission (appId, name, eKind, scope = '') {
  assertPermissionKey(appId, name, eKind, scope)
  for (const lookupName of permissionNamesForLookup(name)) {
    if (await hasPermissionForName(appId, lookupName, eKind, scope)) return true
  }
  return false
}

export async function createOrUpdatePermission (appId, name, eKind, scope = '') {
  assertPermissionKey(appId, name, eKind, scope)
  return run('put', [{ appId, name, eKind, scope }], 'permissions')
}

export async function deletePermission (appId, name, eKind, scope = '') {
  assertPermissionKey(appId, name, eKind, scope)
  return deleteStoredPermission({ appId, name, eKind, scope })
}

export async function deleteAllPermissionsForApp (appId) {
  if (!appId) throw new Error('appId is required')
  const matches = []
  for await (const permission of streamPermissions()) {
    if (permission.appId === appId) matches.push(permission)
  }
  for (const permission of matches) {
    await deleteStoredPermission(permission)
  }
}

async function * streamPermissions (range) {
  const p = Promise.withResolvers()
  const { tx } = await run('openCursor', [range], 'permissions', null, { p })
  const done = tx && new Promise((resolve, reject) => {
    tx.addEventListener('complete', resolve, { once: true })
    tx.addEventListener('abort', () => reject(tx.error || new Error('permission transaction aborted')), { once: true })
  })

  let cursor
  while ((cursor = (await p.promise).result)) {
    yield cursor.value
    Object.assign(p, Promise.withResolvers())
    cursor.continue()
  }
  await done
}

export async function * streamAllPermissionsForApp (appId) {
  if (!appId) throw new Error('appId is required')
  for await (const permission of streamPermissions()) {
    if (permission.appId === appId) yield permission
  }
}

export async function reconcilePermissionScopes ({ registry = SUPPORTED_PERMISSION_SCOPES } = {}) {
  const stale = []
  for await (const permission of streamPermissions()) {
    if (typeof permission?.scope === 'string' &&
      (!permission.scope || permissionScopeEntry(permission.eKind, permission.scope, registry))) continue
    stale.push(permission)
  }
  for (const permission of stale) {
    await deleteStoredPermission(permission)
  }
  return stale.length
}
