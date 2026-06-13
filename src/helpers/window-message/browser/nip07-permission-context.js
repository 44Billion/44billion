const methodNameAliases = {
  nip44v3_encrypt_double_dh: 'nip44v3EncryptDoubleDH',
  nip44v3_decrypt_double_dh: 'nip44v3DecryptDoubleDH'
}

const nip44v3Methods = new Set([
  'nip44v3Encrypt',
  'nip44v3Decrypt',
  'nip44v3EncryptDoubleDH',
  'nip44v3DecryptDoubleDH'
])

const permissionlessMethods = new Set([
  'peekPublicKey',
  'getPublicKey'
])

export function normalizeMethodName (method) {
  if (methodNameAliases[method]) return methodNameAliases[method]
  return method.includes('_')
    ? method.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
    : method
}

function normalizeKind (kind) {
  const n = typeof kind === 'string' && kind.trim() !== '' ? Number(kind) : kind
  return Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : null
}

export function needsNip07Permission (method) {
  return !permissionlessMethods.has(normalizeMethodName(method || ''))
}

export function nip07PermissionContext ({ method, params = [] } = {}) {
  const normalizedMethod = normalizeMethodName(method || '')
  if (normalizedMethod === 'signEvent' || normalizedMethod === 'doubleSignEvent') {
    return { method: normalizedMethod, eKind: params?.[0]?.kind ?? null }
  }
  if (nip44v3Methods.has(normalizedMethod)) {
    return {
      method: normalizedMethod,
      eKind: normalizeKind(params?.[1]),
      scope: String(params?.[2] ?? '')
    }
  }
  return { method: normalizedMethod, eKind: null }
}
