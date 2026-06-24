export const EVENT_READ_PERMISSION = 'eventRead'
export const EVENT_WRITE_PERMISSION = 'eventWrite'
export const ONE_TIME_DELETE_PERMISSION = 'delete'
export const BROAD_EVENT_KIND = -1

const HEX64_RE = /^[0-9a-f]{64}$/i

export function normalizeEventKind (kind, { allowBroad = false } = {}) {
  if (allowBroad && kind === BROAD_EVENT_KIND) return BROAD_EVENT_KIND
  const n = typeof kind === 'string' && kind.trim() !== '' ? Number(kind) : kind
  return Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : null
}

export function permissionNamesForLookup (name) {
  return name === EVENT_READ_PERMISSION
    ? [EVENT_READ_PERMISSION, EVENT_WRITE_PERMISSION]
    : [name]
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

export function eventReadPermission (eKind, options = {}) {
  return eventPermission(EVENT_READ_PERMISSION, eKind, options)
}

export function eventWritePermission (eKind, options = {}) {
  return eventPermission(EVENT_WRITE_PERMISSION, eKind, options)
}

export function eventWritePermissionRequestsForEvent (event) {
  const kind = normalizeEventKind(event?.kind)
  if (kind === null) return []

  if (kind === 5) {
    const targetKinds = deletionTargetKinds(event)
    if (targetKinds) return targetKinds.map(targetKind => eventWritePermission(targetKind))
    return [eventPermission(ONE_TIME_DELETE_PERMISSION, kind, { remember: false })]
  }

  if (kind === 62) return [eventPermission(ONE_TIME_DELETE_PERMISSION, kind, { remember: false })]

  return [eventWritePermission(kind)]
}
