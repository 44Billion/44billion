import {
  PERSONAL_COPY_KIND,
  buildPersonalCopyMirrorData,
  describePersonalCopyInner,
  isPersonalCopyDerivedTag,
  isPersonalCopyEvent,
  parsePersonalCopyPlaintext,
  personalCopyContextValue,
  personalCopyEncryptionKind,
  personalCopyProvenanceValue
} from '#helpers/personal-copy.js'

const HEX64_RE = /^[0-9a-f]{64}$/i
const SIG_RE = /^[0-9a-f]{128}$/i

// A personal copy is a signed kind-1006 wrapper whose created_at matches its
// encrypted inner event or rumor. Plaintext k identifies the inner kind, c is
// the obfuscated context, v records provenance, and domain-separated o tags
// mirror the source ID, effective author, and original one-letter tags. imkc
// carries the content-key proof. Generated wrappers omit d; a manual outer d
// receives ordinary NostrDB replacement behavior.

export async function normalizePersonalCopyForAdd (event, {
  decrypt,
  obfuscate,
  signEvent,
  ownerPubkey
} = {}) {
  if (!isPersonalCopyEvent(event)) return { event, personalCopy: null }

  const personalCopy = await inspectPersonalCopy(event, {
    decrypt,
    obfuscate,
    ownerPubkey
  })
  if (!personalCopy) return null
  if (sameTags(event.tags, personalCopy.canonicalTags)) {
    return { event, personalCopy: metadataForEvent(personalCopy, event) }
  }
  if (typeof signEvent !== 'function') return null

  const template = { ...event, tags: personalCopy.canonicalTags }
  const signed = await signPersonalCopyTemplate(signEvent, template)
  if (!signed) return null

  const signedPersonalCopy = await inspectPersonalCopyTags(signed, personalCopy.innerDescription, {
    obfuscate,
    ownerPubkey
  })
  if (!signedPersonalCopy || !sameTags(signed.tags, signedPersonalCopy.canonicalTags)) return null

  return {
    event: signed,
    personalCopy: metadataForEvent(signedPersonalCopy, signed)
  }
}

export async function validatePersonalCopyForStorage (event, {
  decrypt,
  obfuscate,
  ownerPubkey
} = {}) {
  if (!isPersonalCopyEvent(event)) return null

  const personalCopy = await inspectPersonalCopy(event, {
    decrypt,
    obfuscate,
    ownerPubkey
  })
  if (!personalCopy || !sameTags(event.tags, personalCopy.canonicalTags)) return null
  return metadataForEvent(personalCopy, event)
}

async function inspectPersonalCopy (event, { decrypt, obfuscate, ownerPubkey }) {
  if (typeof decrypt !== 'function' || typeof obfuscate !== 'function') return null

  let plaintext
  try {
    plaintext = await decrypt(event)
  } catch {
    return null
  }

  const inner = parsePersonalCopyPlaintext(event, plaintext)
  if (!inner) return null
  const innerDescription = describePersonalCopyInner(inner, { wrapperPubkey: event.pubkey })
  if (!innerDescription) return null

  return inspectPersonalCopyTags(event, innerDescription, { obfuscate, ownerPubkey })
}

async function inspectPersonalCopyTags (event, innerDescription, { obfuscate, ownerPubkey }) {
  if (event?.pubkey !== ownerPubkey) return null
  if (event.created_at !== innerDescription.inner.created_at) return null
  if (event.tags.some(tag => Array.isArray(tag) && tag[0] === 'hearsay')) return null

  const innerKind = personalCopyEncryptionKind(event)
  const context = personalCopyContextValue(event)
  const provenance = personalCopyProvenanceValue(event)
  if (innerKind !== innerDescription.inner.kind || context === null || provenance === null) return null
  if (!innerDescription.allowedProvenances.includes(provenance)) return null

  let mirrors
  try {
    mirrors = await buildPersonalCopyMirrorData({
      innerEvent: innerDescription.inner,
      wrapperPubkey: event.pubkey,
      obfuscate
    })
  } catch {
    return null
  }

  const contextTag = ['c', context]
  const remainingTags = event.tags.filter(tag =>
    !isPersonalCopyDerivedTag(tag) &&
    !(Array.isArray(tag) && tag[0] === 'c')
  )
  const canonicalTags = [
    ['k', String(innerKind)],
    contextTag,
    ['v', provenance],
    ...mirrors.tags,
    ...remainingTags
  ]

  return {
    canonicalTags,
    context,
    inner: innerDescription.inner,
    innerDescription,
    provenance,
    sourceId: mirrors.sourceId,
    sourceMirror: mirrors.sourceMirror
  }
}

function metadataForEvent (personalCopy, event) {
  return {
    context: personalCopy.context,
    eventId: event.id,
    eventJson: JSON.stringify(event),
    inner: personalCopy.inner,
    provenance: personalCopy.provenance,
    sourceId: personalCopy.sourceId,
    sourceMirror: personalCopy.sourceMirror
  }
}

async function signPersonalCopyTemplate (signEvent, template) {
  const before = JSON.stringify(template)
  let signed

  try {
    signed = await signEvent(template)
  } catch {
    return null
  }

  if (JSON.stringify(template) !== before) return null
  if (!signed || signed.pubkey !== template.pubkey) return null
  if (signed.kind !== PERSONAL_COPY_KIND || signed.created_at !== template.created_at) return null
  if (signed.content !== template.content) return null
  if (!sameTags(signed.tags, template.tags) && !sameTagsAllowingImkcRewrite(signed.tags, template.tags)) return null
  return signed
}

function sameTags (a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((tag, index) => sameTag(tag, b[index]))
}

function sameTag (a, b) {
  return Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, index) => value === b[index])
}

function sameTagsAllowingImkcRewrite (signedTags, templateTags) {
  if (!Array.isArray(signedTags) || !Array.isArray(templateTags) || signedTags.length !== templateTags.length) return false

  let rewritten = 0
  for (let index = 0; index < signedTags.length; index++) {
    if (sameTag(signedTags[index], templateTags[index])) continue
    if (
      templateTags[index]?.length !== 1 ||
      templateTags[index][0] !== 'imkc' ||
      signedTags[index]?.length !== 3 ||
      signedTags[index][0] !== 'imkc' ||
      !HEX64_RE.test(signedTags[index][1] || '') ||
      !SIG_RE.test(signedTags[index][2] || '')
    ) return false
    rewritten++
  }
  return rewritten === 1
}
