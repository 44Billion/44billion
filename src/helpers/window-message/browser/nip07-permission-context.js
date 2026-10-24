import {
  BROAD_EVENT_KIND,
  eventAccessPermissionRequestsForEvent,
  eventAccessPersonalPermissionRequestsForKind,
  LEGACY_CRYPTO_ACCESS_PERMISSION,
  normalizeEventKind
} from './event-permissions.js'
import { ValidationError } from 'libp2r2p/error'

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
  'getPublicKey',
  'obfuscate'
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

export function nip07PermissionContext ({ method, params = [] } = {}) {
  const normalizedMethod = normalizeMethodName(method || '')

  if (normalizedMethod === 'signEvent' || normalizedMethod === 'doubleSignEvent') {
    const event = params?.[0]
    const eKind = normalizeEventKind(event?.kind)
    if (eKind === null) throw new ValidationError('INVALID_KIND')
    const permissions = eventAccessPermissionRequestsForEvent(event)

    return { method: normalizedMethod, eKind, permissions }
  }

  if (nip44v3EncryptMethods.has(normalizedMethod) || nip44v3DecryptMethods.has(normalizedMethod)) {
    const eKind = normalizeEventKind(params?.[1])
    if (eKind === null) throw new ValidationError('INVALID_KIND')
    const permissions = eventAccessPersonalPermissionRequestsForKind(eKind)

    return {
      method: normalizedMethod,
      eKind,
      scope: String(params?.[2] ?? ''),
      permissions
    }
  }

  if (legacyEncryptMethods.has(normalizedMethod) || legacyDecryptMethods.has(normalizedMethod)) {
    return {
      method: normalizedMethod,
      eKind: BROAD_EVENT_KIND,
      permissions: [{ name: LEGACY_CRYPTO_ACCESS_PERMISSION, eKind: BROAD_EVENT_KIND }]
    }
  }

  return { method: normalizedMethod, eKind: null, permissions: [], unknown: true }
}
