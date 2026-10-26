import {
  BROAD_EVENT_KIND,
  eventAccessPermissionRequestsForEvent,
  eventAccessPersonalPermissionRequestsForKind,
  LEGACY_CRYPTO_ACCESS_PERMISSION,
  normalizeEventKind
} from './event-permissions.js'
import { resolvedPermissionScope, SUPPORTED_PERMISSION_SCOPES } from './permission-scopes.js'
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

function withPermissionScope (permissions, kind, scope, scopeRegistry) {
  const resolved = resolvedPermissionScope(kind, scope, scopeRegistry)
  return {
    resolved,
    permissions: permissions.map(permission => ({
      ...permission,
      scope: resolved.scope,
      ...(resolved.labelKey ? { scopeLabelKey: resolved.labelKey } : {})
    }))
  }
}

export function nip07PermissionContext ({ method, params = [], scopeRegistry = SUPPORTED_PERMISSION_SCOPES } = {}) {
  const normalizedMethod = normalizeMethodName(method || '')

  if (normalizedMethod === 'signEvent' || normalizedMethod === 'doubleSignEvent') {
    const event = params?.[0]
    const eKind = normalizeEventKind(event?.kind)
    if (eKind === null) throw new ValidationError('INVALID_KIND')
    const { permissions } = withPermissionScope(eventAccessPermissionRequestsForEvent(event), eKind, '', scopeRegistry)

    return { method: normalizedMethod, eKind, permissions }
  }

  if (nip44v3EncryptMethods.has(normalizedMethod) || nip44v3DecryptMethods.has(normalizedMethod)) {
    const eKind = normalizeEventKind(params?.[1])
    if (eKind === null) throw new ValidationError('INVALID_KIND')
    const { permissions, resolved } = withPermissionScope(
      eventAccessPersonalPermissionRequestsForKind(eKind),
      eKind,
      params?.[2] ?? '',
      scopeRegistry
    )

    return {
      method: normalizedMethod,
      eKind,
      scope: resolved.scope,
      permissions
    }
  }

  if (legacyEncryptMethods.has(normalizedMethod) || legacyDecryptMethods.has(normalizedMethod)) {
    const { permissions } = withPermissionScope(
      [{ name: LEGACY_CRYPTO_ACCESS_PERMISSION, eKind: BROAD_EVENT_KIND }],
      BROAD_EVENT_KIND,
      '',
      scopeRegistry
    )
    return {
      method: normalizedMethod,
      eKind: BROAD_EVENT_KIND,
      permissions
    }
  }

  return { method: normalizedMethod, eKind: null, permissions: [], unknown: true }
}
