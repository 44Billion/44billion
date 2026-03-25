import { run } from '#services/idb/browser/index.js'
import { isNostrAppDTagSafe, appIdToDbAppRef } from '#helpers/app.js'
import { base16ToBytes, bytesToBase16 } from '#helpers/base16.js'

export async function getSiteManifestFromDb (appId) {
  const ref = appIdToDbAppRef(appId)
  return run('get', [ref], 'siteManifests').then(v => v.result && toEvent(v.result))
}

// Caution: use this only when no user has the app installed anymore
export async function deleteSiteManifestFromDb (appId) {
  const ref = appIdToDbAppRef(appId)
  return run('delete', [ref], 'siteManifests')
}

export async function saveSiteManifestToDb (siteManifest, metadata) {
  const record = toDbRecord(siteManifest, metadata)
  return run('put', [record], 'siteManifests')
}

function toDbRecord (event, { hasUpdate = false, lastOpenedAsSingleNappAt = 0 } = {}) {
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
    u: hasUpdate,
    s: lastOpenedAsSingleNappAt,
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
      hasUpdate: record.u,
      lastOpenedAsSingleNappAt: record.s
    }
  }
}
