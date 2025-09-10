import { run } from '#services/idb/browser/index.js'
import { isNostrAppDTagSafe, appIdToDbAppRef } from '#helpers/app.js'
import { base16ToBytes, bytesToBase16 } from '#helpers/base16.js'

export async function getBundleFromDb (appId) {
  const ref = appIdToDbAppRef(appId)
  return run('get', [ref], 'bundles').then(v => v.result && toEvent(v.result))
}

// Caution: use this only when no user has the app installed anymore
export async function deleteBundleFromDb (appId) {
  const ref = appIdToDbAppRef(appId)
  return run('delete', [ref], 'bundles')
}

export async function saveBundleToDb (bundle, metadata) {
  const record = toDbRecord(bundle, metadata)
  return run('put', [record], 'bundles')
}

function toDbRecord (event, { hasUpdate = false, lastOpenedAsSingleNappAt = 0 } = {}) {
  const dTag = event.tags.find(t => t[0] === 'd')?.[1] ?? ''
  if (!isNostrAppDTagSafe(dTag)) throw new Error('Invalid d tag')

  const { kind, pubkey, meta: _, ...evt } = event
  const channelEnum = {
    37448: 'a',
    37449: 'b',
    37450: 'c'
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
    a: 37448, // stable
    b: 37449, // insider
    c: 37450 // vibe coded preview
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
