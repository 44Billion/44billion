/* eslint-disable camelcase */
import { db } from '../../services/db/mdb.js'
import { maxDateNowSeconds } from '../../config/mdb.js'
import { bytesToBase64 } from '../../../src/helpers/base64.js'
import { base16ToBytes } from '../../../src/helpers/base16.js'
import { sha256 } from '@noble/hashes/sha2.js'

export async function getEvents (filter) {
  return searchByNostrFilter(filter)
    .then(v => ({ result: v.hits.map(recordToEvent), errors: [], success: true }))
    .catch((err) => ({ result: null, errors: [err], success: false }))
}

export async function countEvents (filter) {
  return searchByNostrFilter(filter, { metadataOnly: true })
    .then(v => ({ result: v.estimatedTotalHits, errors: [], success: true }))
    .catch((err) => ({ result: null, errors: [err], success: false }))
}

async function searchByNostrFilter ({
  ids, authors, kinds, tags, since, until, limit
}, { metadataOnly = false } = { }) {
  limit = Math.min(limit || 20, 100)
  return db.index('events').search('', {
    limit,
    filter: [
      // inner array is OR clause
      ...(ids ? [ids.map(id => `id = ${db.toMeiliValue(id)}`)] : []),
      ...(authors ? [authors.map(pubkey => `pubkey = ${db.toMeiliValue(pubkey)}`)] : []),
      ...(kinds ? [kinds.map(kind => `kind = ${db.toMeiliValue(kind)}`)] : []),
      ...(tags ? Object.entries(tags).map(([k, vs]) => vs.map(v => `itags = ${db.toMeiliValue(`${k} ${v}`)}`)) : []),
      ...(since ? [`created_at >= ${db.toMeiliValue(since)}`] : []),
      ...(until ? [`created_at <= ${db.toMeiliValue(until)}`] : [])
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
    .then(() => ({ result: record, errors: [], success: true, isPersisted: true }))
    .catch((err) => ({ result: null, errors: [err], success: false, isPersisted: false }))
}

function validateEvent (_event) {
  throw new Error('Not implemented yet')
}

const textEncoder = new TextEncoder()
function eventToRecord (event, { exp, sat, aat } = {}) {
  const { id, kind, pubkey, tags, content, created_at, sig } = event
  const record = { iTags: [], id, kind, pubkey, tags, content, created_at, sig }
  let dTag
  for (const [k, v] of event.tags) {
    if (/[A-Za-z]/.test(k)) record.itags.push(`${k} ${v ?? ''}`)
    switch (k) {
      case 'd': { dTag ??= v ?? ''; break }
      case 'expiration': {
        try {
          const expUint = parseInt(v, 10); if (!Number.isNaN(expUint) && expUint >= 0) { exp ??= Math.min(maxDateNowSeconds, expUint) }
        } catch (_err) {}; break
      }
    }
  }
  const now = Math.floor(Date.now() / 1000)
  Object.assign(record, {
    ref: dTag
      ? bytesToBase64(sha256(textEncoder.encode(`${kind}:${pubkey}:${dTag}`)))
      : bytesToBase64(base16ToBytes(event.id)),
    ...(exp && { exp }),
    sat: sat ?? now,
    aat: aat ?? now
  })
  return record
}

function recordToEvent (record) {
  const { id, kind, pubkey, tags, content, created_at, sig } = record
  return { id, kind, pubkey, tags, content, created_at, sig }
}

export async function deleteEventsById (ids) {
  return db.index('events').deleteDocuments({
    filter: [
      ids.map(id => `id = ${db.toMeiliValue(id)}`)
    ]
  })
    .then(() => ({ result: null, errors: [], success: true }))
    .catch((err) => ({ result: null, errors: [err], success: false }))
}

export async function deleteEventsByRef (refs) {
  // ref field is the pk for the events index
  return db.index('events').deleteDocuments(refs)
    .then(() => ({ result: null, errors: [], success: true }))
    .catch((err) => ({ result: null, errors: [err], success: false }))
}

export async function deleteExpiredEvents () {
  const now = Math.floor(Date.now() / 1000)
  return db.index('events').deleteDocuments({
    filter: [
      `exp <= ${db.toMeiliValue(now)}`
    ]
  })
    .then(() => ({ result: null, errors: [], success: true }))
    .catch((err) => ({ result: null, errors: [err], success: false }))
}
