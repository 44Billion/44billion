import { ask as defaultAsk, reply as defaultReply } from '../index.js'
import { base64ToBytes } from '#helpers/base64.js'
import {
  personalCopyEncryptionKind,
  plaintextBase64
} from '#helpers/personal-copy.js'
import { nostrDbStreamDonePayload } from '../nostrdb-protocol.js'
import {
  deleteNostrDb as defaultDeleteNostrDb,
  getNostrDb as defaultGetNostrDb,
  NOSTRDB_PREFIX
} from '#services/idb/nostrdb/index.js'
import {
  NOSTRDB_MAINTENANCE_CONTEXT,
  NOSTRDB_MERGE_CONTEXT,
  nostrDbMaintenanceOptions,
  nostrDbSignMethodForTemplate,
  runNostrDbMethod
} from './nostrdb.js'

const HEX32 = /^[0-9a-f]{64}$/i
const VAULT_APP = { id: 'ez-vault', name: 'Vault' }
const HEX64 = /^[0-9a-f]{64}$/i
const APP_EXPORT_PAGE_LIMIT = 200
const APP_EXPORT_PAGE_MAX = 999
const textDecoder = new TextDecoder()

function isPlainObject (value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function normalizePositiveInteger (value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Math.floor(Number(value))
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, max) : fallback
}

function normalizeEventId (value) {
  const id = typeof value === 'string' ? value.toLowerCase() : ''
  return HEX64.test(id) ? id : ''
}

function normalizePubkey (value) {
  const pubkey = typeof value === 'string' ? value.toLowerCase() : ''
  return HEX32.test(pubkey) ? pubkey : ''
}

function accountPubkeysFromVaultAccounts (accounts) {
  return new Set((Array.isArray(accounts) ? accounts : [])
    .map(account => normalizePubkey(account?.pubkey))
    .filter(Boolean))
}

export async function pruneNostrDbsForVaultAccounts (accounts, {
  indexedDB = globalThis.indexedDB,
  deleteNostrDb = defaultDeleteNostrDb
} = {}) {
  if (typeof indexedDB?.databases !== 'function') return []

  const keepPubkeys = accountPubkeysFromVaultAccounts(accounts)
  let databases
  try {
    databases = await indexedDB.databases()
  } catch {
    return []
  }

  const deleted = []
  for (const database of Array.isArray(databases) ? databases : []) {
    const name = database?.name
    if (typeof name !== 'string' || !name.startsWith(NOSTRDB_PREFIX)) continue
    const ownerPubkey = normalizePubkey(name.slice(NOSTRDB_PREFIX.length))
    if (!ownerPubkey || keepPubkeys.has(ownerPubkey)) continue
    if (await deleteNostrDb(ownerPubkey)) deleted.push(ownerPubkey)
  }
  return deleted
}

export function normalizeTrustedVaultNostrDbOwner (ownerPubkey) {
  const pubkey = normalizePubkey(ownerPubkey)
  if (!pubkey) throw new Error('NOSTRDB_OWNER_REQUIRED')
  return pubkey
}

export function createTrustedVaultNostrDbSignEvent ({
  vaultPort,
  ownerPubkey,
  context = NOSTRDB_MERGE_CONTEXT,
  getVaultPort = () => vaultPort,
  ask = defaultAsk
}) {
  return async event => {
    const port = getVaultPort()
    if (!port) throw new Error('Vault not connected')
    const { payload, error } = await ask(port, {
      code: 'NIP07',
      payload: {
        app: VAULT_APP,
        pubkey: ownerPubkey,
        ns: [''],
        method: nostrDbSignMethodForTemplate(event),
        params: [event],
        context
      }
    }, { timeout: 120000 })
    if (error) throw error
    return payload
  }
}

export function createTrustedVaultNostrDbPersonalCopyDecrypt ({
  vaultPort,
  ownerPubkey,
  getVaultPort = () => vaultPort,
  ask = defaultAsk
}) {
  return async event => {
    const kind = personalCopyEncryptionKind(event)
    if (kind === null) throw new Error('PERSONAL_COPY_KIND_REQUIRED')
    const port = getVaultPort()
    if (!port) throw new Error('Vault not connected')
    const { payload, error } = await ask(port, {
      code: 'NIP07',
      payload: {
        pubkey: ownerPubkey,
        ns: [''],
        method: 'nip44v3_decrypt',
        params: [ownerPubkey, String(kind), '', event?.content],
        context: 'nostrdb_personal_copy'
      }
    }, { timeout: 120000 })
    if (error) throw error
    return textDecoder.decode(base64ToBytes(String(payload ?? '')))
  }
}

export function createTrustedVaultNostrDbPersonalCopyEncrypt ({
  vaultPort,
  ownerPubkey,
  getVaultPort = () => vaultPort,
  ask = defaultAsk
}) {
  return async (kind, plaintext) => {
    const port = getVaultPort()
    if (!port) throw new Error('Vault not connected')
    const { payload, error } = await ask(port, {
      code: 'NIP07',
      payload: {
        pubkey: ownerPubkey,
        ns: [''],
        method: 'nip44v3_encrypt',
        params: [ownerPubkey, String(kind), '', plaintextBase64(plaintext)],
        context: 'nostrdb_personal_copy'
      }
    }, { timeout: 120000 })
    if (error) throw error
    return payload
  }
}

export function createTrustedVaultNostrDbPersonalCopyObfuscate ({
  vaultPort,
  ownerPubkey,
  getVaultPort = () => vaultPort,
  ask = defaultAsk
}) {
  return async (value, kind, scope) => {
    const port = getVaultPort()
    if (!port) throw new Error('Vault not connected')
    const { payload, error } = await ask(port, {
      code: 'NIP07',
      payload: {
        pubkey: ownerPubkey,
        ns: [''],
        method: 'obfuscate',
        params: [value, String(kind), scope],
        context: 'nostrdb_personal_copy'
      }
    }, { timeout: 120000 })
    if (error) throw error
    return payload
  }
}

export async function runTrustedVaultNostrDbMethod ({
  vaultPort,
  ownerPubkey,
  method,
  params = [],
  getNostrDb = defaultGetNostrDb,
  getVaultPort,
  isAppInstalled = () => true,
  ask = defaultAsk
}) {
  const pubkey = normalizeTrustedVaultNostrDbOwner(ownerPubkey)
  const maintenanceSignEvent = createTrustedVaultNostrDbSignEvent({
    vaultPort,
    ownerPubkey: pubkey,
    context: NOSTRDB_MAINTENANCE_CONTEXT,
    ...(getVaultPort ? { getVaultPort } : {}),
    ask
  })
  const personalCopyDecrypt = createTrustedVaultNostrDbPersonalCopyDecrypt({
    vaultPort,
    ownerPubkey: pubkey,
    ...(getVaultPort ? { getVaultPort } : {}),
    ask
  })
  const personalCopyEncrypt = createTrustedVaultNostrDbPersonalCopyEncrypt({
    vaultPort,
    ownerPubkey: pubkey,
    ...(getVaultPort ? { getVaultPort } : {}),
    ask
  })
  const personalCopyObfuscate = createTrustedVaultNostrDbPersonalCopyObfuscate({
    vaultPort,
    ownerPubkey: pubkey,
    ...(getVaultPort ? { getVaultPort } : {}),
    ask
  })
  const db = getNostrDb(pubkey, {
    ...nostrDbMaintenanceOptions(maintenanceSignEvent),
    personalCopyDecrypt,
    personalCopyObfuscate
  })
  const signEvent = createTrustedVaultNostrDbSignEvent({
    vaultPort,
    ownerPubkey: pubkey,
    ask
  })
  if (method === 'add') {
    const [event, options] = Array.isArray(params) ? params : []
    const normalizedOptions = isPlainObject(options) ? options : {}
    return db.add(event, {
      ...normalizedOptions,
      appId: undefined,
      mergeSource: normalizedOptions.mergeSource === 'sync' ? 'sync' : 'local',
      signEvent
    })
  }
  if (method === 'exportEventsByAppPage') {
    const [appId, options] = Array.isArray(params) ? params : []
    const normalizedOptions = isPlainObject(options) ? options : {}
    const requested = normalizePositiveInteger(
      normalizedOptions.batchSize,
      APP_EXPORT_PAGE_LIMIT,
      APP_EXPORT_PAGE_MAX
    )
    const after = normalizeEventId(normalizedOptions.after)
    const iterator = db.exportEventsByApp(appId, {
      batchSize: requested + 1,
      ...(after ? { after } : {})
    })?.[Symbol.asyncIterator]?.()
    const next = iterator ? await iterator.next() : { done: true }
    await iterator?.return?.()
    const batch = Array.isArray(next.value) ? next.value : []
    const events = batch.slice(0, requested)
    return {
      events,
      nextAfter: events.at(-1)?.id || after || '',
      hasMore: batch.length > requested
    }
  }
  if (method === 'addEventsForApp') {
    const [appId, events] = Array.isArray(params) ? params : []
    const eventRows = Array.isArray(events) ? events : []
    if (!isAppInstalled({ ownerPubkey: pubkey, appId })) {
      return { added: 0, skipped: eventRows.length }
    }
    let added = 0
    let skipped = 0
    for (const event of eventRows) {
      const result = await db.add(event, {
        appId,
        mergeSource: 'sync',
        signEvent
      })
      if (result?.ok === false) skipped++
      else added++
    }
    return { added, skipped }
  }
  return runNostrDbMethod({
    db,
    method,
    params,
    signEvent,
    personalCopyEncrypt,
    personalCopyObfuscate
  })
}

export function cancelTrustedVaultNostrDbSubscription (subscriptions, subscriptionId) {
  const subscription = subscriptions.get(subscriptionId)
  if (!subscription) return
  subscription.cancelled = true
  subscription.iterator?.return?.()
}

export function closeTrustedVaultNostrDbSubscriptions (subscriptions) {
  for (const subscriptionId of subscriptions.keys()) {
    cancelTrustedVaultNostrDbSubscription(subscriptions, subscriptionId)
  }
}

export async function streamTrustedVaultNostrDbSubscription (e, {
  vaultPort,
  ownerPubkey,
  params = [],
  subscriptionId,
  subscriptions,
  getNostrDb = defaultGetNostrDb,
  getVaultPort,
  ask = defaultAsk,
  reply = defaultReply
}) {
  let subscription
  try {
    if (!subscriptionId) throw new Error('NOSTRDB_SUBSCRIPTION_ID_REQUIRED')
    if (subscriptions.has(subscriptionId)) throw new Error('NOSTRDB_SUBSCRIPTION_EXISTS')

    const pubkey = normalizeTrustedVaultNostrDbOwner(ownerPubkey)
    const maintenanceSignEvent = createTrustedVaultNostrDbSignEvent({
      vaultPort,
      ownerPubkey: pubkey,
      context: NOSTRDB_MAINTENANCE_CONTEXT,
      ...(getVaultPort ? { getVaultPort } : {}),
      ask
    })
    const personalCopyDecrypt = createTrustedVaultNostrDbPersonalCopyDecrypt({
      vaultPort,
      ownerPubkey: pubkey,
      ...(getVaultPort ? { getVaultPort } : {}),
      ask
    })
    const db = getNostrDb(pubkey, {
      ...nostrDbMaintenanceOptions(maintenanceSignEvent),
      personalCopyDecrypt
    })
    subscription = { iterator: null, cancelled: false }
    subscriptions.set(subscriptionId, subscription)

    const iterator = db.subscribe(...(Array.isArray(params) ? params : []))
    subscription.iterator = iterator

    for await (const item of iterator) {
      reply(e, { payload: item, isLast: false }, { to: vaultPort })
    }
    if (!subscription.cancelled) {
      reply(e, {
        payload: nostrDbStreamDonePayload(subscriptionId),
        isLast: true
      }, { to: vaultPort })
    }
  } catch (error) {
    if (!subscription?.cancelled) reply(e, { error, isLast: true }, { to: vaultPort })
  } finally {
    if (subscriptions.get(subscriptionId) === subscription) subscriptions.delete(subscriptionId)
  }
}
