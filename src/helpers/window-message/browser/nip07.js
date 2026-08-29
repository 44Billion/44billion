import {
  needsNip07Permission,
  nip07PermissionContext
} from './nip07-permission-context.js'
import { guardSignerRequest } from './signer-guard.js'

export async function askNip07 (
  askVault, pubkey, { ns = [''], withSharedKey = null, method, params = [], context = '' }, {
    isDefaultUser = false,
    isReadOnly = false,
    isLocked = false,
    onSignerRequestAttention,
    requestPermission,
    app,
    permissionMeta
  } = {}
) {
  guardSignerRequest({
    method,
    params,
    account: { isDefaultUser, isReadOnly, isLocked },
    onAttention: onSignerRequestAttention
  })
  if (requestPermission && needsNip07Permission(method)) {
    const { permissions, scope, unknown } = nip07PermissionContext({ method, params })
    if (unknown) throw new Error(`Unknown method ${method}`)

    for (const permission of permissions) {
      await requestPermission({
        app,
        ...permission,
        meta: {
          params,
          ...(scope === undefined ? {} : { scope }),
          ...permission.meta,
          ...(permissionMeta || {})
        }
      })
    }
  }

  const { napp, ...appRest } = app
  const msg = {
    code: 'NIP07',
    payload: {
      app: {
        ...appRest,
        id: napp // for vault, this is the id
      },
      pubkey,
      ns, // [name, ...optionalArgs]
      ...(withSharedKey ? { with_shared_key: withSharedKey } : {}),
      method,
      params,
      ...(context ? { context } : {})
    }
  }
  return askVault(msg, { timeout: 120000 })
}
