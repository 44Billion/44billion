import { ValidationError } from 'libp2r2p/error'

export function createPermissionScopeRegistry (entries = []) {
  const registry = new Map()
  for (const { kind, scope, labelKey } of entries) {
    if (!Number.isInteger(kind) || typeof scope !== 'string' || !scope || typeof labelKey !== 'string' || !labelKey) {
      throw new Error('INVALID_PERMISSION_SCOPE_ENTRY')
    }
    let scopes = registry.get(kind)
    if (!scopes) registry.set(kind, scopes = new Map())
    if (scopes.has(scope)) throw new Error('DUPLICATE_PERMISSION_SCOPE')
    scopes.set(scope, Object.freeze({ labelKey }))
  }
  return registry
}

// Scope support is launcher-owned. An empty registry intentionally falls back
// to kind-wide grants until an interoperable scope receives a user-facing label.
export const SUPPORTED_PERMISSION_SCOPES = createPermissionScopeRegistry()

export function permissionScopeEntry (kind, scope, registry = SUPPORTED_PERMISSION_SCOPES) {
  if (!scope || typeof scope !== 'string') return null
  const entry = registry.get(kind)?.get(scope)
  return entry && typeof entry.labelKey === 'string' && entry.labelKey ? entry : null
}

export function resolvedPermissionScope (kind, scope, registry = SUPPORTED_PERMISSION_SCOPES) {
  if (scope == null) scope = ''
  if (typeof scope !== 'string') throw new ValidationError('INVALID_SCOPE')
  const entry = permissionScopeEntry(kind, scope, registry)
  return entry
    ? { scope, labelKey: entry.labelKey }
    : { scope: '', labelKey: null }
}

export function * permissionScopeEntries (registry = SUPPORTED_PERMISSION_SCOPES) {
  for (const [kind, scopes] of registry) {
    for (const [scope, entry] of scopes) yield { kind, scope, labelKey: entry.labelKey }
  }
}
