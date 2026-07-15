import {
  buildPersonalCopyMirrorTags,
  canonicalPersonalCopyInner,
  isPersonalCopyEvent,
  isSelfOwnedPersonalCopyInner,
  isVerifiedSignedPersonalCopyInner,
  parsePersonalCopyPlaintext,
  personalCopyHearsayState,
  personalCopyInnerAddress,
  personalCopySourceId,
  stripPersonalCopyDerivedTags
} from '#helpers/personal-copy.js'

import { buildCrdtMergeTemplate } from './crdt.js'

export async function normalizePersonalCopyForAdd (event, {
  decrypt,
  obfuscate,
  signEvent,
  ownerPubkey
} = {}) {
  if (!isPersonalCopyEvent(event)) return event
  if (personalCopyHearsayState(event) === 'invalid') return null
  if (typeof decrypt !== 'function') return event

  const provenance = await getPersonalCopyProvenance(event, { decrypt, ownerPubkey })
  if (!provenance || provenance.hearsayState === 'invalid') return null
  if (
    provenance.hearsayState === 'hearsay' &&
    (provenance.selfOwned || provenance.signed || provenance.sourceId === null)
  ) return null

  const inner = canonicalPersonalCopyInner(provenance.inner, {
    wrapperPubkey: event.pubkey,
    ownerPubkey
  }) ?? provenance.inner

  if (typeof obfuscate !== 'function' || typeof signEvent !== 'function') return event

  const mirrorTags = await buildPersonalCopyMirrorTags({
    innerEvent: inner,
    obfuscate
  })
  const tags = [...mirrorTags, ...stripPersonalCopyDerivedTags(event.tags)]
  if (sameTags(tags, event.tags)) return event

  return signEvent({
    ...event,
    tags
  })
}

export async function getPersonalCopyProvenance (event, { decrypt, ownerPubkey } = {}) {
  if (!isPersonalCopyEvent(event) || typeof decrypt !== 'function') return null

  const record = await decryptPersonalCopyRecord(event, decrypt)
  if (!record) return null

  const selfOwned = isSelfOwnedPersonalCopyInner({
    innerEvent: record.inner,
    wrapperPubkey: event.pubkey,
    ownerPubkey
  })

  return {
    inner: record.inner,
    selfOwned,
    signed: isVerifiedSignedPersonalCopyInner(record.inner),
    hearsayState: personalCopyHearsayState(event),
    sourceId: selfOwned ? null : personalCopySourceId(record.inner)
  }
}

export async function buildPersonalCopyMergeTemplate (incoming, existing, {
  decrypt,
  encrypt,
  obfuscate,
  crdtOptions,
  ownerPubkey
} = {}) {
  if (typeof obfuscate !== 'function') return null
  if (!hasTag(incoming, 'd')) return null

  const incomingRecord = await decryptPersonalCopyRecord(incoming, decrypt)
  if (!incomingRecord) return null
  if (!isSelfOwnedPersonalCopyInner({
    innerEvent: incomingRecord.inner,
    wrapperPubkey: incoming.pubkey,
    ownerPubkey
  })) return null

  const incomingInner = canonicalPersonalCopyInner(incomingRecord.inner, {
    wrapperPubkey: incoming.pubkey,
    ownerPubkey
  })
  const incomingAddress = personalCopyInnerAddress(incomingInner, { wrapperPubkey: incoming.pubkey })
  if (incomingAddress === null) return null

  const existingRecord = existing ? await decryptPersonalCopyRecord(existing, decrypt) : null
  if (existing && !existingRecord) return null

  let mergedInner = incomingInner
  let content = await contentForPlaintext({
    plaintext: JSON.stringify(incomingInner),
    incomingRecord,
    existingRecord,
    encrypt,
    kind: incomingInner.kind
  })
  if (content === null) return null

  if (existingRecord) {
    if (!hasTag(existing, 'd')) return null
    if (!isSelfOwnedPersonalCopyInner({
      innerEvent: existingRecord.inner,
      wrapperPubkey: existing.pubkey,
      ownerPubkey
    })) return null

    const existingInner = canonicalPersonalCopyInner(existingRecord.inner, {
      wrapperPubkey: existing.pubkey,
      ownerPubkey
    })
    const existingAddress = personalCopyInnerAddress(existingInner, { wrapperPubkey: existing.pubkey })
    if (incomingAddress !== existingAddress) return null

    const incomingPlaintext = JSON.stringify(incomingInner)
    const existingPlaintext = JSON.stringify(existingInner)
    if (incomingPlaintext === existingPlaintext && samePersonalCopyOuterMetadata(incoming, existing)) {
      return null
    } else {
      mergedInner = buildCrdtMergeTemplate(
        incomingInner,
        existingInner,
        crdtOptions
      )
      if (!mergedInner) return null

      const mergedPlaintext = JSON.stringify(mergedInner)
      content = await contentForPlaintext({
        plaintext: mergedPlaintext,
        incomingRecord,
        existingRecord,
        encrypt,
        kind: mergedInner.kind
      })
      if (content === null) return null
    }
  }

  const incomingOuter = {
    ...incoming,
    content,
    tags: stripPersonalCopyDerivedTags(incoming.tags)
  }
  const existingOuter = existing
    ? {
        ...existing,
        tags: stripPersonalCopyDerivedTags(existing.tags)
      }
    : null
  const template = buildCrdtMergeTemplate(incomingOuter, existingOuter, crdtOptions)
  if (!template) return null

  const mirrorTags = await buildPersonalCopyMirrorTags({
    innerEvent: mergedInner,
    obfuscate
  })
  return {
    ...template,
    tags: [...mirrorTags, ...stripPersonalCopyDerivedTags(template.tags)]
  }
}

async function decryptPersonalCopyRecord (event, decrypt) {
  if (typeof decrypt !== 'function') return null
  try {
    const plaintext = await decrypt(event)
    const inner = parsePersonalCopyPlaintext(event, plaintext)
    return inner ? { event, plaintext, inner } : null
  } catch {
    return null
  }
}

async function contentForPlaintext ({
  plaintext,
  incomingRecord,
  existingRecord,
  encrypt,
  kind
}) {
  if (incomingRecord?.plaintext === plaintext) return incomingRecord.event.content
  if (existingRecord?.plaintext === plaintext) return existingRecord.event.content
  if (typeof encrypt !== 'function') return null
  return encrypt(kind, plaintext)
}

function hasTag (event, name) {
  return Array.isArray(event?.tags) && event.tags.some(tag => Array.isArray(tag) && tag[0] === name)
}

function samePersonalCopyOuterMetadata (a, b) {
  return canonicalPersonalCopyOuterMetadata(a) === canonicalPersonalCopyOuterMetadata(b)
}

function canonicalPersonalCopyOuterMetadata (event) {
  return JSON.stringify(
    stripPersonalCopyDerivedTags(event?.tags)
      .map(normalizePersonalCopyMetadataTag)
      .filter(Boolean)
      .sort(compareJson)
  )
}

function normalizePersonalCopyMetadataTag (tag) {
  if (!Array.isArray(tag) || typeof tag[0] !== 'string') return null
  if (tag[0] === '~' || tag[0] === 'imkc') return null

  const values = tag
    .map(value => String(value))
    .filter(value => !value.startsWith('~'))

  return values.length > 0 ? values : null
}

function compareJson (a, b) {
  const aa = JSON.stringify(a)
  const bb = JSON.stringify(b)
  if (aa === bb) return 0
  return aa < bb ? -1 : 1
}

function sameTags (a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false

  return a.every((tag, index) => sameTag(tag, b[index]))
}

function sameTag (a, b) {
  return Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, valueIndex) => value === b[valueIndex])
}
