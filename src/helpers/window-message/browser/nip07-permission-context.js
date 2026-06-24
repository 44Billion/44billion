import {
  BROAD_EVENT_KIND,
  EVENT_READ_PERMISSION,
  EVENT_WRITE_PERMISSION,
  eventReadPermission,
  eventWritePermission,
  eventWritePermissionRequestsForEvent,
  normalizeEventKind
} from './event-permissions.js'

const methodNameAliases = {
  nip44v3_encrypt_double_dh: 'nip44v3EncryptDoubleDH',
  nip44v3_decrypt_double_dh: 'nip44v3DecryptDoubleDH'
}

const nip44v3EncryptMethods = new Set([
  'nip44v3Encrypt',
  'nip44v3EncryptDoubleDH'
])

const nip44v3DecryptMethods = new Set([
  'nip44v3Decrypt',
  'nip44v3DecryptDoubleDH'
])

const legacyEncryptMethods = new Set([
  'nip04Encrypt',
  'nip44Encrypt'
])

const legacyDecryptMethods = new Set([
  'nip04Decrypt',
  'nip44Decrypt'
])

const permissionlessMethods = new Set([
  'peekPublicKey',
  'getPublicKey'
])

export function normalizeMethodName (method) {
  const value = String(method ?? '')
  if (methodNameAliases[value]) return methodNameAliases[value]
  return value.includes('_')
    ? value.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
    : value
}

export function needsNip07Permission (method) {
  return !permissionlessMethods.has(normalizeMethodName(method || ''))
}

function oneTimeEventPermission (name) {
  return { name, eKind: null, remember: false }
}

export function nip07PermissionContext ({ method, params = [] } = {}) {
  const normalizedMethod = normalizeMethodName(method || '')

  if (normalizedMethod === 'signEvent' || normalizedMethod === 'doubleSignEvent') {
    const event = params?.[0]
    const eKind = normalizeEventKind(event?.kind)
    const permissions = eKind === null
      ? [oneTimeEventPermission(EVENT_WRITE_PERMISSION)]
      : eventWritePermissionRequestsForEvent(event)

    return { method: normalizedMethod, eKind, permissions }
  }

  if (nip44v3EncryptMethods.has(normalizedMethod) || nip44v3DecryptMethods.has(normalizedMethod)) {
    const eKind = normalizeEventKind(params?.[1])
    const name = nip44v3DecryptMethods.has(normalizedMethod)
      ? EVENT_READ_PERMISSION
      : EVENT_WRITE_PERMISSION
    const permission = eKind === null
      ? oneTimeEventPermission(name)
      : (name === EVENT_READ_PERMISSION ? eventReadPermission(eKind) : eventWritePermission(eKind))

    return {
      method: normalizedMethod,
      eKind,
      scope: String(params?.[2] ?? ''),
      permissions: [permission]
    }
  }

  if (legacyEncryptMethods.has(normalizedMethod) || legacyDecryptMethods.has(normalizedMethod)) {
    const name = legacyDecryptMethods.has(normalizedMethod)
      ? EVENT_READ_PERMISSION
      : EVENT_WRITE_PERMISSION
    return {
      method: normalizedMethod,
      eKind: BROAD_EVENT_KIND,
      permissions: [name === EVENT_READ_PERMISSION
        ? eventReadPermission(BROAD_EVENT_KIND)
        : eventWritePermission(BROAD_EVENT_KIND)]
    }
  }

  return { method: normalizedMethod, eKind: null, permissions: [] }
}
