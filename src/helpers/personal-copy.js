import { getEventHash, validateEvent, verifyEvent } from 'nostr-tools'

import { eventKinds } from '#constants/event.js'
import { bytesToBase64Url } from 'libp2r2p/base64'

const textEncoder = new TextEncoder()
const HEX64_RE = /^[0-9a-f]{64}$/i
const SIG_RE = /^[0-9a-f]{128}$/i
const TEMPLATE_FIELDS = ['content', 'created_at', 'kind', 'tags']
const RUMOR_FIELDS = [...TEMPLATE_FIELDS, 'pubkey'].sort()
const SIGNED_EVENT_FIELDS = [...RUMOR_FIELDS, 'id', 'sig'].sort()

export const PERSONAL_COPY_KIND = eventKinds.PERSONAL_COPY
export const PERSONAL_COPY_PROVENANCE_TAG = 'v'
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
    return validateEvent(event) && event.id === getEventHash(event) && verifyEvent(event)
  } catch {
    return false
  }
}

// Rumors and self-owned templates use the ID their equivalent signed event has.
export function personalCopySourceId (innerEvent, { wrapperPubkey } = {}) {
  return describePersonalCopyInner(innerEvent, { wrapperPubkey })?.sourceId ?? null
}

export async function buildPersonalCopyUnsignedEvent ({
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

  const prepared = preparePersonalCopyInner(originalEvent, ownerPubkey)
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
  const tags = await buildPersonalCopyTags({
    innerEvent: prepared.inner,
    wrapperPubkey: ownerPubkey,
    context,
    provenance,
    obfuscate
  })

  // The vault fills this proof while signing the outer wrapper.
  tags.push(['imkc'])

  return {
    kind: PERSONAL_COPY_KIND,
    created_at: prepared.inner.created_at,
    tags,
    content
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

  return [
    ['k', String(innerEvent.kind)],
    ['c', await obfuscate(String(context ?? ''), PERSONAL_COPY_KIND, '')],
    [PERSONAL_COPY_PROVENANCE_TAG, provenance],
    ...mirrors.tags
  ]
}

export async function buildPersonalCopyMirrorData ({ innerEvent, wrapperPubkey, obfuscate }) {
  const description = describePersonalCopyInner(innerEvent, { wrapperPubkey })
  if (!description) throw new Error('INVALID_PERSONAL_COPY_INNER_EVENT')
  if (typeof obfuscate !== 'function') throw new Error('PERSONAL_COPY_OBFUSCATE_REQUIRED')

  const tags = []
  for (const tag of innerEvent.tags) {
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
    (tag[0] === 'k' || tag[0] === 'o' || tag[0] === PERSONAL_COPY_PROVENANCE_TAG)
}

export function plaintextBase64 (plaintext) {
  return bytesToBase64Url(textEncoder.encode(String(plaintext ?? '')))
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
