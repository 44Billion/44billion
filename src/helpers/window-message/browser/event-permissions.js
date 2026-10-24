export const EVENT_ACCESS_PERMISSION = 'eventAccess'
export const EVENT_ACCESS_PERSONAL_PERMISSION = 'eventAccessPersonal'
export const LEGACY_CRYPTO_ACCESS_PERMISSION = 'legacyCryptoAccess'
export const ONE_TIME_DELETE_PERMISSION = 'delete'
export const BROAD_EVENT_KIND = -1
export const PRIVATE_CHANNEL_ROUTER_KIND = 26300
export const PRIVATE_CHANNEL_NYM_CARRIER_KIND = 26400
export const PRIVATE_CHANNEL_KIND = 3560
export const PERSONAL_COPY_WRAPPER_KIND = 1006

const HEX64_RE = /^[0-9a-f]{64}$/i
const PRIVATE_CHANNEL_TRANSPORT_KINDS = new Set([
  PRIVATE_CHANNEL_ROUTER_KIND,
  PRIVATE_CHANNEL_NYM_CARRIER_KIND
])
const EVENT_ACCESS_EXEMPT_KINDS = new Set([
  PRIVATE_CHANNEL_KIND,
  PERSONAL_COPY_WRAPPER_KIND
])
const PERSONAL_CRYPTO_EXEMPT_KINDS = new Set([
  PRIVATE_CHANNEL_KIND
])

export function normalizeEventKind (kind, { allowBroad = false } = {}) {
  if (allowBroad && kind === BROAD_EVENT_KIND) return BROAD_EVENT_KIND
  const n = typeof kind === 'string' && kind.trim() !== '' ? Number(kind) : kind
  return Number.isInteger(n) && n >= 0 && n <= 0xffff ? n : null
}

export function permissionNamesForLookup (name) {
  return [name]
}

export function isPrivateChannelTransportKind (kind) {
  const normalized = normalizeEventKind(kind)
  return normalized !== null && PRIVATE_CHANNEL_TRANSPORT_KINDS.has(normalized)
}

function parseAddressKind (address) {
  if (typeof address !== 'string') return null
  const [kindPart, pubkey] = address.split(':')
  const kind = normalizeEventKind(kindPart)
  if (kind === null || !HEX64_RE.test(pubkey || '')) return null
  return kind
}

export function deletionTargetKinds (event) {
  if (!Array.isArray(event?.tags)) return null

  const targetTags = event.tags.filter(tag => Array.isArray(tag) && (tag[0] === 'a' || tag[0] === 'e'))
  if (targetTags.length === 0 || targetTags.some(tag => tag[0] !== 'a')) return null

  const kinds = []
  for (const tag of targetTags) {
    const kind = parseAddressKind(tag[1])
    if (kind === null) return null
    kinds.push(kind)
  }
  return [...new Set(kinds)].sort((a, b) => a - b)
}

export function eventPermission (name, eKind, options = {}) {
  return {
    name,
    eKind,
    ...options
  }
}

export function eventAccessPermission (eKind, options = {}) {
  return eventPermission(EVENT_ACCESS_PERMISSION, eKind, options)
}

export function eventAccessPersonalPermission (eKind, options = {}) {
  return eventPermission(EVENT_ACCESS_PERSONAL_PERMISSION, eKind, options)
}

export function eventAccessPermissionRequestsForKind (kind, options = {}) {
  const { allowGenericExemptions = true, ...permissionOptions } = options
  const normalized = normalizeEventKind(kind, { allowBroad: true })
  if (normalized === null) return []
  if (normalized !== BROAD_EVENT_KIND && isPrivateChannelTransportKind(normalized)) return []
  if (allowGenericExemptions && normalized !== BROAD_EVENT_KIND && EVENT_ACCESS_EXEMPT_KINDS.has(normalized)) return []
  return [eventAccessPermission(normalized, permissionOptions)]
}

export function eventAccessPersonalPermissionRequestsForKind (kind, options = {}) {
  const normalized = normalizeEventKind(kind, { allowBroad: true })
  if (normalized === null) return []
  if (normalized !== BROAD_EVENT_KIND && isPrivateChannelTransportKind(normalized)) return []
  if (normalized !== BROAD_EVENT_KIND && PERSONAL_CRYPTO_EXEMPT_KINDS.has(normalized)) return []
  return [eventAccessPersonalPermission(normalized, options)]
}

export function eventAccessPermissionRequestsForEvent (event) {
  const kind = normalizeEventKind(event?.kind)
  if (kind === null) return []

  if (kind === 5) {
    const targetKinds = deletionTargetKinds(event)
    if (targetKinds) {
      return targetKinds.flatMap(targetKind => eventAccessPermissionRequestsForKind(targetKind, {
        allowGenericExemptions: false
      }))
    }
    return [eventPermission(ONE_TIME_DELETE_PERMISSION, kind, { remember: false })]
  }

  if (kind === 62) return [eventPermission(ONE_TIME_DELETE_PERMISSION, kind, { remember: false })]

  return eventAccessPermissionRequestsForKind(kind)
}
