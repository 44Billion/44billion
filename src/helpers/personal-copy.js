import { eventKinds } from '#constants/event.js'
import { bytesToBase64 } from '#helpers/base64.js'

const textEncoder = new TextEncoder()
const HEX64_RE = /^[0-9a-f]{64}$/i

export const PERSONAL_COPY_KIND = eventKinds.PERSONAL_COPY ?? eventKinds.LOCAL_COPY ?? 1006

export function normalizeEventKind (kind, { allowBroad = false } = {}) {
  if (allowBroad && kind === -1) return -1
  const n = typeof kind === 'string' && kind.trim() !== '' ? Number(kind) : kind
  return Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : null
}

export function isPersonalCopyEvent (event) {
  return normalizeEventKind(event?.kind) === PERSONAL_COPY_KIND
}

export function personalCopyHintKinds (event) {
  if (!Array.isArray(event?.tags)) return []
  return [...new Set(event.tags
    .filter(tag => Array.isArray(tag) && tag[0] === 'k')
    .map(tag => normalizeEventKind(tag[1]))
    .filter(kind => kind !== null))]
    .sort((a, b) => a - b)
}

export function personalCopyEncryptionKind (event) {
  const kinds = personalCopyHintKinds(event)
  return kinds.length === 1 ? kinds[0] : null
}

export function parsePersonalCopyPlaintext (event, plaintext) {
  const inner = parseJsonObject(plaintext)
  const innerKind = normalizeEventKind(inner?.kind)
  const hintKind = personalCopyEncryptionKind(event)
  if (!inner || innerKind === null || hintKind === null || innerKind !== hintKind) return null
  return normalizeInnerEvent(inner)
}

export async function buildPersonalCopyUnsignedEvent ({
  originalEvent,
  ownerPubkey,
  context = '',
  encrypt,
  obfuscate,
  now = () => Math.floor(Date.now() / 1000)
}) {
  const inner = normalizeInnerEvent(originalEvent)
  if (!inner) throw new Error('INVALID_PERSONAL_COPY_INNER_EVENT')
  if (!HEX64_RE.test(ownerPubkey || '')) throw new Error('PERSONAL_COPY_OWNER_REQUIRED')
  if (typeof encrypt !== 'function') throw new Error('PERSONAL_COPY_ENCRYPT_REQUIRED')
  if (typeof obfuscate !== 'function') throw new Error('PERSONAL_COPY_OBFUSCATE_REQUIRED')

  const normalizedContext = String(context ?? '')
  const plaintext = JSON.stringify(inner)
  const content = await encrypt(inner.kind, plaintext)
  const tags = await buildPersonalCopyTags({
    innerEvent: inner,
    context: normalizedContext,
    obfuscate
  })

  tags.push(['imkc'])

  return {
    kind: PERSONAL_COPY_KIND,
    created_at: Number.isInteger(inner.created_at) ? inner.created_at : now(),
    tags,
    content
  }
}

export async function buildPersonalCopyTags ({ innerEvent, context = '', obfuscate }) {
  const inner = normalizeInnerEvent(innerEvent)
  if (!inner) throw new Error('INVALID_PERSONAL_COPY_INNER_EVENT')
  if (typeof obfuscate !== 'function') throw new Error('PERSONAL_COPY_OBFUSCATE_REQUIRED')

  const tags = [
    ['k', String(inner.kind)],
    ['c', await obfuscate(String(context ?? ''), PERSONAL_COPY_KIND, '')]
  ]
  const address = personalCopyInnerAddress(inner)
  if (address !== null) {
    tags.push(['d', await obfuscate(personalCopyDValue(context, address), PERSONAL_COPY_KIND, '#d')])
  }

  tags.push(...await buildPersonalCopyMirrorTags({ innerEvent: inner, obfuscate }).then(mirrorTags => mirrorTags.slice(1)))

  return tags
}

export async function buildPersonalCopyMirrorTags ({ innerEvent, obfuscate }) {
  const inner = normalizeInnerEvent(innerEvent)
  if (!inner) throw new Error('INVALID_PERSONAL_COPY_INNER_EVENT')
  if (typeof obfuscate !== 'function') throw new Error('PERSONAL_COPY_OBFUSCATE_REQUIRED')

  const tags = [['k', String(inner.kind)]]
  for (const tag of inner.tags) {
    if (!Array.isArray(tag) || typeof tag[0] !== 'string' || tag[0].length !== 1) continue
    if (typeof tag[1] !== 'string') continue
    tags.push(['o', await obfuscate(tag[1], PERSONAL_COPY_KIND, `#${tag[0]}`)])
  }

  if (typeof inner.id === 'string' && HEX64_RE.test(inner.id)) {
    tags.push(['o', await obfuscate(inner.id, PERSONAL_COPY_KIND, '.id')])
  }
  if (typeof inner.pubkey === 'string' && HEX64_RE.test(inner.pubkey)) {
    tags.push(['o', await obfuscate(inner.pubkey, PERSONAL_COPY_KIND, '.pubkey')])
  }
  return tags
}

export function personalCopyDValue (context, address) {
  return JSON.stringify(['personal-copy-d-v1', String(context ?? ''), String(address ?? '')])
}

export function personalCopyInnerAddress (event) {
  const kind = normalizeEventKind(event?.kind)
  const pubkey = typeof event?.pubkey === 'string' && HEX64_RE.test(event.pubkey) ? event.pubkey : null
  if (kind === null || !pubkey || !isEditableKind(kind)) return null
  const d = getDTag(event) ?? ''
  return `${kind}:${pubkey}:${d}`
}

export function isEditableKind (kind) {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000)
}

export function stripPersonalCopyDerivedTags (tags) {
  return (Array.isArray(tags) ? tags : []).filter(tag => !isPersonalCopyDerivedTag(tag))
}

export function isPersonalCopyDerivedTag (tag) {
  return Array.isArray(tag) && (tag[0] === 'k' || tag[0] === 'o')
}

export function plaintextBase64 (plaintext) {
  return bytesToBase64(textEncoder.encode(String(plaintext ?? '')))
}

export function normalizeInnerEvent (event) {
  const kind = normalizeEventKind(event?.kind)
  if (kind === null || !event || typeof event !== 'object' || Array.isArray(event)) return null
  return {
    ...event,
    kind,
    tags: Array.isArray(event.tags) ? event.tags.filter(Array.isArray).map(tag => tag.map(value => String(value))) : [],
    content: typeof event.content === 'string' ? event.content : ''
  }
}

function getDTag (event) {
  return Array.isArray(event?.tags)
    ? event.tags.find(tag => Array.isArray(tag) && tag[0] === 'd')?.[1] ?? null
    : null
}

function parseJsonObject (value) {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
