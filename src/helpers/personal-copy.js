import { getEventHash, isValidEvent } from 'libp2r2p/event'
import { isAddressableKind, isEphemeralKind, isReplaceableKind } from 'libp2r2p/kind'
import { eventKinds } from '#constants/event.js'

const textEncoder = new TextEncoder()
const HEX64_RE = /^[0-9a-f]{64}$/i
const SIG_RE = /^[0-9a-f]{128}$/i
const TEMPLATE_FIELDS = ['content', 'created_at', 'kind', 'tags']
const RUMOR_FIELDS = [...TEMPLATE_FIELDS, 'pubkey'].sort()
const SIGNED_EVENT_FIELDS = [...RUMOR_FIELDS, 'id', 'sig'].sort()

export const PERSONAL_COPY_KIND = eventKinds.PERSONAL_COPY
export const PERSONAL_COPY_PROVENANCE_TAG = 'v'
export const PERSONAL_COPY_ADDRESS_SCOPE = '.coordinate'
export const PERSONAL_COPY_PROVENANCE = Object.freeze({
  SIGNED_EVENT: '0',
  DIRECT_RUMOR: '1',
  HEARSAY_RUMOR: '2'
})

const PERSONAL_COPY_PROVENANCE_VALUES = new Set(Object.values(PERSONAL_COPY_PROVENANCE))

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
  const tags = exactNamedTags(event, 'k')
  if (tags.length !== 1 || tags[0].length !== 2) return null

  const kind = normalizeEventKind(tags[0][1])
  return kind !== null && tags[0][1] === String(kind) ? kind : null
}

export function personalCopyContextValue (event) {
  const tags = exactNamedTags(event, 'c')
  return tags.length === 1 && tags[0].length === 2 && typeof tags[0][1] === 'string'
    ? tags[0][1]
    : null
}

export function personalCopyProvenanceValue (event) {
  const tags = exactNamedTags(event, PERSONAL_COPY_PROVENANCE_TAG)
  if (tags.length !== 1 || tags[0].length !== 2) return null
  return PERSONAL_COPY_PROVENANCE_VALUES.has(tags[0][1]) ? tags[0][1] : null
}

export function parsePersonalCopyPlaintext (event, plaintext) {
  const inner = parseJsonObject(plaintext)
  const hintKind = personalCopyEncryptionKind(event)
  if (!inner || hintKind === null || inner.kind !== hintKind) return null

  return describePersonalCopyInner(inner, { wrapperPubkey: event?.pubkey })?.inner ?? null
}

export function describePersonalCopyInner (innerEvent, { wrapperPubkey } = {}) {
  if (!isPlainObject(innerEvent)) return null

  if (hasAnyOwn(innerEvent, ['id', 'sig'])) {
    if (!hasExactFields(innerEvent, SIGNED_EVENT_FIELDS) || !isVerifiedSignedPersonalCopyInner(innerEvent)) return null
    return {
      inner: innerEvent,
      signed: true,
      selfOwned: innerEvent.pubkey === wrapperPubkey,
      effectivePubkey: innerEvent.pubkey,
      sourceId: innerEvent.id,
      allowedProvenances: [PERSONAL_COPY_PROVENANCE.SIGNED_EVENT]
    }
  }

  if (hasExactFields(innerEvent, TEMPLATE_FIELDS)) {
    if (!HEX64_RE.test(wrapperPubkey || '') || !hasValidInnerBase(innerEvent)) return null
    const sourceId = hashPersonalCopyInner(innerEvent, wrapperPubkey)
    if (!HEX64_RE.test(sourceId || '')) return null
    return {
      inner: innerEvent,
      signed: false,
      selfOwned: true,
      effectivePubkey: wrapperPubkey,
      sourceId,
      allowedProvenances: [PERSONAL_COPY_PROVENANCE.DIRECT_RUMOR]
    }
  }

  if (!hasExactFields(innerEvent, RUMOR_FIELDS) || !hasValidInnerBase(innerEvent)) return null
  if (!HEX64_RE.test(innerEvent.pubkey || '')) return null
  if (HEX64_RE.test(wrapperPubkey || '') && innerEvent.pubkey === wrapperPubkey) return null
  const sourceId = hashPersonalCopyInner(innerEvent, innerEvent.pubkey)
  if (!HEX64_RE.test(sourceId || '')) return null

  return {
    inner: innerEvent,
    signed: false,
    selfOwned: false,
    effectivePubkey: innerEvent.pubkey,
    sourceId,
    allowedProvenances: [
      PERSONAL_COPY_PROVENANCE.DIRECT_RUMOR,
      PERSONAL_COPY_PROVENANCE.HEARSAY_RUMOR
    ]
  }
}

function isVerifiedSignedPersonalCopyInner (event) {
  if (!isPlainObject(event) || !hasExactFields(event, SIGNED_EVENT_FIELDS)) return false
  if (!HEX64_RE.test(event.id || '') || !HEX64_RE.test(event.pubkey || '') || !SIG_RE.test(event.sig || '')) return false
  if (!hasValidInnerBase(event)) return false

  try {
    return isValidEvent(event)
  } catch {
    return false
  }
}

// Rumors and self-owned templates use the ID their equivalent signed event has.
export function personalCopySourceId (innerEvent, { wrapperPubkey } = {}) {
  return describePersonalCopyInner(innerEvent, { wrapperPubkey })?.sourceId ?? null
}

export async function buildPersonalCopyUnsignedEvent (options) {
  return (await preparePersonalCopyUnsignedEvent(options)).event
}

// Internal preparation keeps the validated inner snapshot alongside its wrapper.
// Callers must bind it to the final signed wrapper before reusing it for ingest.
export async function preparePersonalCopyUnsignedEvent ({
  originalEvent,
  ownerPubkey,
  context = '',
  hearsay = false,
  encrypt,
  obfuscate
}) {
  if (!HEX64_RE.test(ownerPubkey || '')) throw new Error('PERSONAL_COPY_OWNER_REQUIRED')
  if (typeof hearsay !== 'boolean') throw new Error('INVALID_PERSONAL_COPY_HEARSAY')
  if (typeof encrypt !== 'function') throw new Error('PERSONAL_COPY_ENCRYPT_REQUIRED')
  if (typeof obfuscate !== 'function') throw new Error('PERSONAL_COPY_OBFUSCATE_REQUIRED')

  const prepared = preparePersonalCopyInner(structuredClone(originalEvent), ownerPubkey)
  if (!prepared) throw new Error('INVALID_PERSONAL_COPY_INNER_EVENT')
  if (hearsay && prepared.signed) throw new Error('HEARSAY_SIGNED_EVENT')
  if (hearsay && prepared.selfOwned) throw new Error('HEARSAY_SELF_OWNED_EVENT')

  const provenance = hearsay
    ? PERSONAL_COPY_PROVENANCE.HEARSAY_RUMOR
    : prepared.signed
      ? PERSONAL_COPY_PROVENANCE.SIGNED_EVENT
      : PERSONAL_COPY_PROVENANCE.DIRECT_RUMOR
  const plaintext = JSON.stringify(prepared.inner)
  const content = await encrypt(prepared.inner.kind, plaintext)
  const mirrors = await buildMirrorDataFromDescription(prepared, obfuscate)
  const contextValue = await obfuscate(String(context ?? ''), PERSONAL_COPY_KIND, '')
  // The address includes the context: the same inner coordinate in two
  // contexts is two independent copies.
  const addressTag = await personalCopyCoordinateTag({
    innerEvent: prepared.inner,
    wrapperPubkey: ownerPubkey,
    contextValue,
    obfuscate
  })
  const expirationTag = personalCopyExpirationTag(prepared.inner)
  const tags = [
    ['k', String(prepared.inner.kind)],
    ['c', contextValue],
    [PERSONAL_COPY_PROVENANCE_TAG, provenance],
    ...(addressTag ? [addressTag] : []),
    ...mirrors.tags,
    ...(expirationTag ? [expirationTag] : []),
    // The vault fills this proof while signing the outer wrapper.
    ['imkc']
  ]

  return {
    event: {
      kind: PERSONAL_COPY_KIND,
      created_at: prepared.inner.created_at,
      tags,
      content
    },
    personalCopy: {
      context: contextValue,
      inner: prepared.inner,
      provenance,
      sourceId: mirrors.sourceId,
      sourceMirror: mirrors.sourceMirror
    }
  }
}

export async function buildPersonalCopyTags ({
  innerEvent,
  wrapperPubkey,
  context = '',
  provenance,
  obfuscate
}) {
  const description = describePersonalCopyInner(innerEvent, { wrapperPubkey })
  if (!description || !description.allowedProvenances.includes(provenance)) {
    throw new Error('INVALID_PERSONAL_COPY_PROVENANCE')
  }
  if (typeof obfuscate !== 'function') throw new Error('PERSONAL_COPY_OBFUSCATE_REQUIRED')

  const mirrors = await buildPersonalCopyMirrorData({
    innerEvent,
    wrapperPubkey,
    obfuscate
  })
  const contextValue = await obfuscate(String(context ?? ''), PERSONAL_COPY_KIND, '')
  const addressTag = await personalCopyCoordinateTag({ innerEvent, wrapperPubkey, contextValue, obfuscate })
  const expirationTag = personalCopyExpirationTag(innerEvent)

  return [
    ['k', String(innerEvent.kind)],
    ['c', contextValue],
    [PERSONAL_COPY_PROVENANCE_TAG, provenance],
    ...(addressTag ? [addressTag] : []),
    ...mirrors.tags,
    ...(expirationTag ? [expirationTag] : [])
  ]
}

// The wrapper address identifies the inner coordinate (kind, effective author
// and `d` tag) so replaceable/addressable copies replace each other without
// leaking the inner values. Kind 0/3 and the replaceable range use an empty
// dtag; addressable kinds use their own.
export async function personalCopyCoordinate ({ innerEvent, wrapperPubkey, contextValue = '', obfuscate }) {
  if (typeof obfuscate !== 'function') return null
  const description = describePersonalCopyInner(innerEvent, { wrapperPubkey })
  if (!description || !hasCoordinate(description.inner)) return null
  return personalCopyCoordinateValue({
    kind: description.inner.kind,
    author: description.effectivePubkey,
    dtag: innerDTag(description.inner),
    contextValue,
    obfuscate
  })
}

// The wrapper `d` is always derived, never app-chosen: context, inner kind,
// effective author and dtag (empty for replaceable kinds 0/3 and 10000–19999).
export async function personalCopyCoordinateValue ({ kind, author, dtag, contextValue = '', obfuscate }) {
  if (typeof obfuscate !== 'function') return null
  return obfuscate(
    `${contextValue}:${kind}:${author}:${dtag}`,
    PERSONAL_COPY_KIND,
    PERSONAL_COPY_ADDRESS_SCOPE
  )
}

export async function personalCopyCoordinateTag (options) {
  const value = await personalCopyCoordinate(options)
  return value === null ? null : ['d', value]
}

// Mirrors the store's getCoordinate eligibility (kind ranges plus a `d` tag
// fallback) and keeps ephemeral inners out of the address space.
function hasCoordinate (inner) {
  if (isEphemeralKind(inner.kind)) return false
  if (inner.tags.some(tag => Array.isArray(tag) && tag[0] === 'expiration' && tag[1] === String(inner.created_at))) return false
  return isReplaceableKind(inner.kind) ||
    isAddressableKind(inner.kind) ||
    inner.tags.some(tag => Array.isArray(tag) && tag[0] === 'd')
}

function innerDTag (inner) {
  return inner.tags.find(tag => Array.isArray(tag) && tag[0] === 'd')?.[1] ?? ''
}

// NIP-40 expiration is copied from the inner event to the wrapper so the
// wrapper inherits the same lifetime (including honorary ephemeral semantics).
export function personalCopyExpirationTag (innerEvent) {
  if (!Array.isArray(innerEvent?.tags)) return null

  for (const tag of innerEvent.tags) {
    if (!Array.isArray(tag) || tag[0] !== 'expiration' || typeof tag[1] !== 'string') continue
    if (!/^\d+$/.test(tag[1])) continue

    const timestamp = Number(tag[1])
    if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) continue
    return ['expiration', String(timestamp)]
  }

  return null
}

export async function buildPersonalCopyMirrorData ({ innerEvent, wrapperPubkey, obfuscate }) {
  const description = describePersonalCopyInner(innerEvent, { wrapperPubkey })
  if (!description) throw new Error('INVALID_PERSONAL_COPY_INNER_EVENT')
  if (typeof obfuscate !== 'function') throw new Error('PERSONAL_COPY_OBFUSCATE_REQUIRED')

  return buildMirrorDataFromDescription(description, obfuscate)
}

async function buildMirrorDataFromDescription (description, obfuscate) {
  const tags = []
  for (const tag of description.inner.tags) {
    if (tag[0].length !== 1 || typeof tag[1] !== 'string') continue
    tags.push(['o', await obfuscate(tag[1], PERSONAL_COPY_KIND, `#${tag[0]}`)])
  }

  const sourceMirror = await obfuscate(description.sourceId, PERSONAL_COPY_KIND, '.id')
  const authorMirror = await obfuscate(description.effectivePubkey, PERSONAL_COPY_KIND, '.pubkey')
  tags.push(['o', sourceMirror], ['o', authorMirror])

  return {
    tags,
    sourceId: description.sourceId,
    sourceMirror,
    authorMirror
  }
}

export function isPersonalCopyDerivedTag (tag) {
  return Array.isArray(tag) &&
    (tag[0] === 'k' || tag[0] === 'o' || tag[0] === 'd' || tag[0] === PERSONAL_COPY_PROVENANCE_TAG)
}

export function plaintextArrayBuffer (plaintext) {
  // The local vault channel carries plaintext bytes without Base64 conversion.
  return textEncoder.encode(String(plaintext ?? '')).buffer
}

function preparePersonalCopyInner (innerEvent, ownerPubkey) {
  if (!isPlainObject(innerEvent)) return null

  if (hasExactFields(innerEvent, SIGNED_EVENT_FIELDS)) {
    return describePersonalCopyInner(innerEvent, { wrapperPubkey: ownerPubkey })
  }

  if (hasExactFields(innerEvent, TEMPLATE_FIELDS)) {
    return describePersonalCopyInner(innerEvent, { wrapperPubkey: ownerPubkey })
  }

  if (!hasExactFields(innerEvent, RUMOR_FIELDS) || !hasValidInnerBase(innerEvent)) return null
  if (!HEX64_RE.test(innerEvent.pubkey || '')) return null

  if (innerEvent.pubkey !== ownerPubkey) {
    return describePersonalCopyInner(innerEvent, { wrapperPubkey: ownerPubkey })
  }

  const template = {
    kind: innerEvent.kind,
    created_at: innerEvent.created_at,
    tags: innerEvent.tags,
    content: innerEvent.content
  }
  return describePersonalCopyInner(template, { wrapperPubkey: ownerPubkey })
}

function hashPersonalCopyInner (innerEvent, pubkey) {
  try {
    return getEventHash({
      pubkey,
      created_at: innerEvent.created_at,
      kind: innerEvent.kind,
      tags: innerEvent.tags,
      content: innerEvent.content
    })
  } catch {
    return null
  }
}

function hasValidInnerBase (event) {
  return Number.isInteger(event.kind) &&
    event.kind >= 0 &&
    event.kind <= 0xffff &&
    Number.isInteger(event.created_at) &&
    event.created_at >= 0 &&
    event.created_at <= 0xffffffff &&
    Array.isArray(event.tags) &&
    event.tags.every(tag => Array.isArray(tag) && tag.every(value => typeof value === 'string')) &&
    typeof event.content === 'string'
}

function exactNamedTags (event, name) {
  return Array.isArray(event?.tags)
    ? event.tags.filter(tag => Array.isArray(tag) && tag[0] === name)
    : []
}

function isPlainObject (value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasAnyOwn (value, names) {
  return names.some(name => Object.hasOwn(value, name))
}

function hasExactFields (value, fields) {
  const keys = Object.keys(value).sort()
  return keys.length === fields.length && keys.every((key, index) => key === fields[index])
}

function parseJsonObject (value) {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}
