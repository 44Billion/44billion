import { sha256 } from '@noble/hashes/sha2.js'
import { encode } from 'libp2r2p/base93'
import { bytesToBase16 } from 'libp2r2p/base16'
import { verifyEvent } from 'nostr-tools'

import { parseIrfsChunkEvent } from '#services/irfs-chunk.js'

const EVENT_KEYS = ['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags']

function sameTags (left, right) {
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((tag, index) =>
      Array.isArray(tag) &&
      Array.isArray(right[index]) &&
      tag.length === right[index].length &&
      tag.every((value, valueIndex) => value === right[index][valueIndex])
    )
}

function hasSignedFields (event) {
  return event && (
    Object.hasOwn(event, 'id') ||
    Object.hasOwn(event, 'sig')
  )
}

export function verifyNostrEventWithoutCache (event) {
  if (!event || typeof event !== 'object') return false
  return verifyEvent({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: Array.isArray(event.tags)
      ? event.tags.map(tag => Array.isArray(tag) ? [...tag] : tag)
      : event.tags,
    content: event.content,
    sig: event.sig
  })
}

function hasOnlyCanonicalEventFields (event) {
  const keys = Object.keys(event).sort()
  return keys.length === EVENT_KEYS.length && keys.every((key, index) => key === EVENT_KEYS[index])
}

function canonicalChunkData (event) {
  const parsed = parseIrfsChunkEvent(event)
  const canonicalContent = encode(parsed.contentBytes)
  const canonicalProof = encode(parsed.proof)
  const tags = [
    ['d', parsed.d],
    ['mmr', String(parsed.index), String(parsed.total), canonicalProof]
  ]
  return {
    ...parsed,
    byteLength: parsed.contentBytes.byteLength,
    canonicalContent,
    canonicalProof,
    contentHash: bytesToBase16(sha256(parsed.contentBytes)),
    tags
  }
}

function validateSignedInput (event) {
  if (!hasSignedFields(event)) return false
  if (
    typeof event.id !== 'string' ||
    typeof event.sig !== 'string' ||
    typeof event.pubkey !== 'string' ||
    !verifyNostrEventWithoutCache(event)
  ) throw new Error('Invalid signed chunk event')
  return true
}

function isCanonicalOwnerEvent (event, ownerPubkey, data) {
  return event.pubkey === ownerPubkey &&
    event.content === data.canonicalContent &&
    sameTags(event.tags, data.tags) &&
    hasOnlyCanonicalEventFields(event)
}

function validSignedCanonicalResult (event, template, ownerPubkey, data) {
  return event?.pubkey === ownerPubkey &&
    event.kind === 34601 &&
    event.created_at === template.created_at &&
    event.content === data.canonicalContent &&
    sameTags(event.tags, data.tags) &&
    hasOnlyCanonicalEventFields(event) &&
    verifyNostrEventWithoutCache(event)
}

export async function normalizeChunkEventForOwner (event, {
  ownerPubkey,
  signEvent,
  allowUnsigned = false
} = {}) {
  const data = canonicalChunkData(event)
  const signed = validateSignedInput(event)
  if (!signed && !allowUnsigned) throw new Error('Unsigned public chunk event')

  if (signed && isCanonicalOwnerEvent(event, ownerPubkey, data)) {
    return { event, data }
  }
  if (typeof signEvent !== 'function') throw new Error('Chunk owner signing unavailable')

  const template = {
    kind: 34601,
    created_at: event.created_at,
    tags: data.tags.map(tag => [...tag]),
    content: data.canonicalContent
  }
  const snapshot = JSON.stringify(template)
  const normalized = await signEvent(template)
  if (JSON.stringify(template) !== snapshot) throw new Error('Chunk signer mutated its template')
  if (!validSignedCanonicalResult(normalized, template, ownerPubkey, data)) {
    throw new Error('Chunk signer returned an invalid event')
  }
  return { event: normalized, data }
}

export function validateCanonicalOwnerChunkEvent (event, ownerPubkey) {
  const data = canonicalChunkData(event)
  validateSignedInput(event)
  if (!isCanonicalOwnerEvent(event, ownerPubkey, data)) throw new Error('Non-canonical owner chunk event')
  return data
}

export function blobReferencesFromTags (tags) {
  if (!Array.isArray(tags)) return []
  return [...new Set(tags
    .filter(tag => Array.isArray(tag) && tag[0] === 'r' && /^[0-9a-f]{64}$/.test(tag[1] || ''))
    .map(tag => tag[1]))]
    .sort()
}
