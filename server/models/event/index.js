/* eslint-disable camelcase */
import { db } from '../../services/db/mdb.js'
import { maxDateNowSeconds } from '../../config/mdb.js'
import { bytesToBase64 } from '../../../src/helpers/base64.js'
import { base16ToBytes } from '../../../src/helpers/base16.js'
import { sha256 } from '@noble/hashes/sha2.js'

export async function getEventByRef (ref, options = {}) {
  return db.index('events').getDocument(ref, {
    ...(options.fields && { fields: options.fields })
  })
    .then(record => ({ result: recordToEvent(record), error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

// Good to update metadata such as lastAccessedAt
export async function patchEventByRef (ref, patch) {
  // this would add doc if it doesn't exist
  // return db.index('events').updateDocuments([{
  //   ref,
  //   ...patch
  // }])
  const record = await db.index('events').getDocument(ref)
  if (!record) {
    return { result: null, error: new Error('Event not found'), success: false }
  }

  return record.update(patch)
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

export async function getEvents (filter, { fields } = {}) {
  if (fields === undefined) {
    fields = [
      'id',
      'pubkey',
      'kind',
      'nonIndexableTags',
      'indexableTags',
      'indexableTagExtras',
      'nonFtsContent',
      'ftsContent',
      'created_at',
      'sig'
    ]
  }
  return searchByNostrFilter(filter, { fields })
    .then(v => ({ result: v.hits.map(recordToEvent), error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

export async function countEvents (filter) {
  return searchByNostrFilter(filter, { metadataOnly: true })
    .then(v => ({ result: v.estimatedTotalHits, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

async function searchByNostrFilter ({
  ids, authors, kinds, tags, since, until, limit,
  search = '' // nip50
}, { metadataOnly = false, fields } = { }) {
  limit = Math.min(limit || 20, 100)
  let language
  let q = search

  if (q) {
    const match = q.match(/language:([a-zA-Z]{2})/)
    if (match) language = match[1].toLowerCase()
    q = q
      .replace(/language:[a-zA-Z]{2}/g, '')
      .replace(/followers:(>=|<=|>|<)?\d+/g, '')
      .replace(/sort:(hot|top|new|old)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  return db.index('events').search(q, {
    ...(fields && { fields }),
    limit,
    filter: [
      // inner array is OR clause
      ...(ids ? [ids.map(id => `id = ${db.toMeiliValue(id)}`)] : []),
      ...(authors ? [authors.map(pubkey => `pubkey = ${db.toMeiliValue(pubkey)}`)] : []),
      ...(kinds ? [kinds.map(kind => `kind = ${db.toMeiliValue(kind)}`)] : []),
      ...(tags ? Object.entries(tags).map(([k, vs]) => vs.map(v => `indexableTags = ${db.toMeiliValue(`${k} ${v}`)}`)) : []),
      ...(since ? [`created_at >= ${db.toMeiliValue(since)}`] : []),
      ...(until ? [`created_at <= ${db.toMeiliValue(until)}`] : []),
      ...(language ? [`language = ${db.toMeiliValue(language)}`] : [])
    ],
    sort: ['created_at:desc'],
    offset: metadataOnly
      ? db.constants.maxTotalHits // hack to get no v.hits
      : 0
  })
}

export async function upsertEvent (event, options = {}) {
  validateEvent(event)
  const record = eventToRecord(event, options)
  if (record.exp != null && record.exp <= Math.floor(Date.now() / 1000)) return { result: record, success: true, isPersisted: false }
  return db.index('events').addDocuments([record])
    .then(() => ({ result: record, error: null, success: true, isPersisted: true }))
    .catch(error => ({ result: null, error, success: false, isPersisted: false }))
}

function validateEvent (_event) {
  throw new Error('Not implemented yet')
}

const textEncoder = new TextEncoder()
function eventToRecord (event, { language, expiresAt, lastAccessedAt, receivedAt, isContentSearchable = false, fts } = {}) {
  const { id, kind, pubkey, created_at, sig } = event
  const record = { id, kind, pubkey, created_at, sig }

  let dTag
  let tagIndex = 0
  for (const [k, v, ...extraValues] of event.tags) {
    if (/[A-Za-z]/.test(k) && (
      v !== undefined ||
      (k === 'd' && kind >= 10000 && kind < 20000) // defaults the value to '' in this case
    )) {
      (record.indexableTags ??= []).push(`${k} ${v ?? ''}`)
      ;(record.indexableTagExtras ??= []).push([tagIndex, ...extraValues])
    } else {
      (record.nonIndexableTags ??= []).push(event.tags[tagIndex])
    }
    switch (k) {
      case 'd': { if (v !== undefined || (kind >= 10000 && kind < 20000)) dTag ??= v ?? ''; break }
      case 'expiration': {
        try {
          const expUint = parseInt(v, 10); if (!Number.isNaN(expUint) && expUint >= 0) { expiresAt ??= Math.min(maxDateNowSeconds, expUint) }
        } catch (_err) {}; break
      }
    }
    tagIndex++
  }
  const now = Math.floor(Date.now() / 1000)
  Object.assign(record, {
    ref: dTag
      ? bytesToBase64(sha256(textEncoder.encode(`${kind}:${pubkey}:${dTag}`)))
      : bytesToBase64(base16ToBytes(event.id)),
    ...(language && { language }),
    ...(fts && { fts }),
    ...(isContentSearchable ? { ftsContent: event.content } : { nonFtsContent: event.content }),
    ...(expiresAt && { expiresAt }),
    lastAccessedAt: lastAccessedAt ?? now,
    receivedAt: receivedAt ?? now
  })
  return record
}

function recordToEvent (record) {
  const {
    id, kind, pubkey, created_at, sig,
    indexableTags = [], indexableTagExtras = [], nonIndexableTags,
    ftsContent, nonFtsContent
  } = record
  const content = ftsContent ?? nonFtsContent ?? ''
  // reconstruct tags
  const tags = Array.isArray(nonIndexableTags) ? [...nonIndexableTags] : []
  for (let i = 0; i < indexableTags.length; i++) {
    const [k, v] = indexableTags[i].split(' ', 2)
    const [tagIndex, ...extraValues] = indexableTagExtras[i]
    tags.splice(tagIndex, 0, [k, v, ...extraValues])
  }
  return { id, kind, pubkey, tags, content, created_at, sig }
}

export async function deleteEventsById (ids) {
  return db.index('events').deleteDocuments({
    filter: [
      ids.map(id => `id = ${db.toMeiliValue(id)}`)
    ]
  })
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

export async function deleteEventsByRef (refs) {
  // ref field is the primary key of the events index
  return db.index('events').deleteDocuments(refs)
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}

export async function deleteExpiredEvents () {
  const now = Math.floor(Date.now() / 1000)
  return db.index('events').deleteDocuments({
    filter: [
      `exp <= ${db.toMeiliValue(now)}`
    ]
  })
    .then(() => ({ result: null, error: null, success: true }))
    .catch(error => ({ result: null, error, success: false }))
}
