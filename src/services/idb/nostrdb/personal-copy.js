import {
  buildPersonalCopyMirrorTags,
  isPersonalCopyEvent,
  parsePersonalCopyPlaintext,
  personalCopyInnerAddress,
  stripPersonalCopyDerivedTags
} from '#helpers/personal-copy.js'

import { buildCrdtMergeTemplate } from './crdt.js'

export async function normalizePersonalCopyForAdd (event, {
  decrypt,
  obfuscate,
  signEvent
} = {}) {
  if (!isPersonalCopyEvent(event)) return event
  if (typeof decrypt !== 'function') return event

  const inner = await decryptPersonalCopyInner(event, decrypt)
  if (!inner) return null

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

export async function buildPersonalCopyMergeTemplate (incoming, existing, {
  decrypt,
  encrypt,
  obfuscate,
  crdtOptions
} = {}) {
  if (typeof obfuscate !== 'function') return null

  const incomingInner = await decryptPersonalCopyInner(incoming, decrypt)
  if (!incomingInner) return null

  const existingInner = existing ? await decryptPersonalCopyInner(existing, decrypt) : null
  if (existing && !existingInner) return null

  let mergedInner = incomingInner
  let content = incoming.content
  if (existingInner) {
    const incomingAddress = personalCopyInnerAddress(incomingInner)
    const existingAddress = personalCopyInnerAddress(existingInner)
    if (incomingAddress === null || incomingAddress !== existingAddress) return null

    const incomingPlaintext = JSON.stringify(stripEventSignature(incomingInner))
    const existingPlaintext = JSON.stringify(stripEventSignature(existingInner))
    if (incomingPlaintext === existingPlaintext && samePersonalCopyOuterMetadata(incoming, existing)) {
      return null
    } else {
      mergedInner = buildCrdtMergeTemplate(
        stripEventSignature(incomingInner),
        stripEventSignature(existingInner),
        crdtOptions
      )
      if (!mergedInner) return null

      const mergedPlaintext = JSON.stringify(mergedInner)
      if (mergedPlaintext === incomingPlaintext) {
        content = incoming.content
      } else if (mergedPlaintext === existingPlaintext) {
        content = existing.content
      } else if (typeof encrypt === 'function') {
        content = await encrypt(mergedInner.kind, mergedPlaintext)
      } else {
        return null
      }
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

async function decryptPersonalCopyInner (event, decrypt) {
  if (typeof decrypt !== 'function') return null
  try {
    return parsePersonalCopyPlaintext(event, await decrypt(event))
  } catch {
    return null
  }
}

function stripEventSignature (event) {
  if (!event || typeof event !== 'object') return event
  const { id, sig, ...rest } = event
  return rest
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
