import { run } from '#services/idb/browser/index.js'
import { isNostrAppDTagSafe, appIdToDbAppRef } from '#helpers/app.js'
import { base16ToBytes, bytesToBase16 } from '#helpers/base16.js'

const HEX_PUBKEY = /^[0-9a-f]{64}$/i

export async function getSiteManifestFromDb (appId) {
  const ref = appIdToDbAppRef(appId)
  return run('get', [ref], 'siteManifests').then(v => v.result && toEvent(v.result))
}

// Caution: use this only when no user has the app installed anymore
export async function deleteSiteManifestFromDb (appId) {
  const ref = appIdToDbAppRef(appId)
  return run('delete', [ref], 'siteManifests')
}

export async function listSiteManifestsFromDb ({ db } = {}) {
  const p = Promise.withResolvers()
  await run('openCursor', [], 'siteManifests', null, { db, p })
  const events = []

  let cursor
  while ((cursor = (await p.promise).result)) {
    events.push(toEvent(cursor.value))
    Object.assign(p, Promise.withResolvers())
    cursor.continue()
  }

  return events
}

export async function saveSiteManifestToDb (siteManifest, metadata) {
  const record = toDbRecord(siteManifest, metadata)
  return run('put', [record], 'siteManifests')
}

export function normalizeSingleNappOpenedAtByOwner (value) {
  const ret = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ret
  for (const [ownerPubkey, timestamp] of Object.entries(value)) {
    const owner = String(ownerPubkey || '').toLowerCase()
    const openedAt = Number(timestamp)
    if (!HEX_PUBKEY.test(owner) || !Number.isFinite(openedAt) || openedAt <= 0) continue
    ret[owner] = openedAt
  }
  return ret
}

export function withSingleNappOpenedAtByOwner (metadata, ownerPubkey, openedAt = Date.now()) {
  const owner = String(ownerPubkey || '').toLowerCase()
  if (!HEX_PUBKEY.test(owner)) return { ...(metadata || {}) }
  return {
    ...(metadata || {}),
    singleNappOpenedAtByOwner: {
      ...normalizeSingleNappOpenedAtByOwner(metadata?.singleNappOpenedAtByOwner),
      [owner]: openedAt
    }
  }
}

function toDbRecord (event, {
  singleNappOpenedAtByOwner = {},
  latestUpdateEventId = null,
  seenUpdateEventId = null
} = {}) {
  const dTag = event.tags.find(t => t[0] === 'd')?.[1] ?? ''
  if (!isNostrAppDTagSafe(dTag)) throw new Error('Invalid d tag')

  const { kind, pubkey, meta: _, ...evt } = event
  const channelEnum = {
    35128: 'a',
    35129: 'b',
    35130: 'c'
  }[kind]
  if (!channelEnum) throw new Error('Invalid kind')
  return {
    c: channelEnum,
    p: base16ToBytes(pubkey),
    d: dTag,
    s: normalizeSingleNappOpenedAtByOwner(singleNappOpenedAtByOwner),
    lu: latestUpdateEventId,
    su: seenUpdateEventId,
    evt
  }
}

function toEvent (record) {
  const kind = {
    a: 35128, // main
    b: 35129, // next
    c: 35130  // draft
  }[record.c]
  if (!kind) throw new Error('Invalid channel')
  return {
    kind,
    pubkey: bytesToBase16(record.p),
    ...record.evt,
    meta: {
      singleNappOpenedAtByOwner: normalizeSingleNappOpenedAtByOwner(record.s),
      latestUpdateEventId: record.lu ?? null,
      seenUpdateEventId: record.su ?? null
    }
  }
}
