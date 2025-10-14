import { run } from '#services/idb/browser/index.js'

export async function hasPermission (appId, name, eKind) {
  if (!appId || !name || eKind == null) throw new Error('appId, name and eKind are required')
  if (eKind === -1 /* wildcard */) {
    return run('get', [[appId, name, -1]], 'permissions').then(v => !!v.result)
  }

  const range = IDBKeyRange.bound([appId, name, -1], [appId, name, eKind])
  const p = Promise.withResolvers()
  run('openKeyCursor', [range], 'permissions', null, { p })

  let cursor
  let keyEKind
  const continueKey = [appId, name, eKind]
  while ((cursor = (await p.promise).result)) {
    keyEKind = cursor.primaryKey[2]
    if (keyEKind === -1 || keyEKind === eKind) return true

    Object.assign(p, Promise.withResolvers())
    cursor.continue(continueKey)
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
