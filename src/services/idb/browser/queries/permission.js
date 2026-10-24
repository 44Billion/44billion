import { permissionNamesForLookup } from '#helpers/window-message/browser/event-permissions.js'
import { run } from '#services/idb/browser/index.js'

async function hasPermissionForName (appId, name, eKind) {
  return run('get', [[appId, name, eKind]], 'permissions').then(value => !!value.result)
}

export async function hasPermission (appId, name, eKind) {
  if (!appId || !name || eKind == null) throw new Error('appId, name and eKind are required')
  for (const lookupName of permissionNamesForLookup(name)) {
    if (await hasPermissionForName(appId, lookupName, eKind)) return true
  }
  return false
}

export async function createOrUpdatePermission (appId, name, eKind) {
  if (!appId || !name || eKind == null) throw new Error('appId, name and eKind are required')
  return run('put', [{ appId, name, eKind }], 'permissions')
}

export async function deletePermission (appId, name, eKind) {
  if (!appId || !name || eKind == null) throw new Error('appId, name and eKind are required')
  return run('delete', [[appId, name, eKind]], 'permissions')
}

export async function deleteAllPermissionsForApp (appId) {
  if (!appId) throw new Error('appId is required')
  const range = IDBKeyRange.bound([appId], [appId, '\uffff', '\uffff'])
  return run('clear', [range], 'permissions')
}

export async function * streamAllPermissionsForApp (appId) {
  if (!appId) throw new Error('appId is required')
  const range = IDBKeyRange.bound([appId], [appId, '\uffff', '\uffff'])

  const p = Promise.withResolvers()
  run('openCursor', [range], 'permissions', null, { p })

  let cursor
  while ((cursor = (await p.promise).result)) {
    yield cursor.value
    Object.assign(p, Promise.withResolvers())
    cursor.continue()
  }
}
