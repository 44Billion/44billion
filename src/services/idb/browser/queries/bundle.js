import { run } from '#services/idb/browser/index.js'
import { isNostrAppDTagSafe, appIdToDbAppRef } from '#helpers/app.js'
import { base16ToBytes, bytesToBase16 } from '#helpers/base16.js'

export async function getBundleFromDb (appId) {
  const ref = appIdToDbAppRef(appId)
  return run('get', [ref], 'bundles').then(v => v.result && toEvent(v.result))
}

export async function saveBundleToDb (bundle) {
  const record = toDbRecord(bundle)
  return run('put', [record], 'bundles')
}

function toDbRecord (event, { hasUpdate = false } = {}) {
  const dTag = event.tags.find(t => t[0] === 'd')?.[1] ?? ''
  if (!isNostrAppDTagSafe(dTag)) throw new Error('Invalid d tag')

  const { kind, pubkey, ...evt } = event
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
    kind: record.c,
    pubkey: bytesToBase16(record.p),
    ...record.evt
  }
}
