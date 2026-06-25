import { ask as defaultAsk, reply as defaultReply } from '../index.js'
import { nostrDbStreamDonePayload } from '../nostrdb-protocol.js'
import { getNostrDb as defaultGetNostrDb } from '#services/idb/nostrdb/index.js'
import { nostrDbSignMethodForTemplate, runNostrDbMethod } from './nostrdb.js'

const HEX32 = /^[0-9a-f]{64}$/i
const VAULT_APP = { id: 'ez-vault', name: 'Vault' }

function normalizePubkey (value) {
  const pubkey = typeof value === 'string' ? value.toLowerCase() : ''
  return HEX32.test(pubkey) ? pubkey : ''
}

export function accountPubkeysFromVaultAccounts (accounts) {
  return new Set((Array.isArray(accounts) ? accounts : [])
    .map(account => normalizePubkey(account?.pubkey))
    .filter(Boolean))
}

export function assertTrustedVaultNostrDbOwner (ownerPubkey, allowedPubkeys) {
  const pubkey = normalizePubkey(ownerPubkey)
  if (!pubkey) throw new Error('NOSTRDB_OWNER_REQUIRED')
  if (allowedPubkeys && !allowedPubkeys.has(pubkey)) throw new Error('NOSTRDB_OWNER_NOT_AVAILABLE')
  return pubkey
}

export function createTrustedVaultNostrDbSignEvent ({
  vaultPort,
  ownerPubkey,
  ask = defaultAsk
}) {
  return async event => {
    const { payload, error } = await ask(vaultPort, {
      code: 'NIP07',
      payload: {
        app: VAULT_APP,
        pubkey: ownerPubkey,
        ns: [''],
        method: nostrDbSignMethodForTemplate(event),
        params: [event],
        context: 'nostrdb_merge'
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
  allowedPubkeys,
  getNostrDb = defaultGetNostrDb,
  ask = defaultAsk
}) {
  const pubkey = assertTrustedVaultNostrDbOwner(ownerPubkey, allowedPubkeys)
  const db = getNostrDb(pubkey)
  const signEvent = createTrustedVaultNostrDbSignEvent({
    vaultPort,
    ownerPubkey: pubkey,
    ask
  })
  return runNostrDbMethod({
    db,
    method,
    params,
    signEvent
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
  allowedPubkeys,
  subscriptions,
  getNostrDb = defaultGetNostrDb,
  reply = defaultReply
}) {
  let subscription
  try {
    if (!subscriptionId) throw new Error('NOSTRDB_SUBSCRIPTION_ID_REQUIRED')
    if (subscriptions.has(subscriptionId)) throw new Error('NOSTRDB_SUBSCRIPTION_EXISTS')

    const pubkey = assertTrustedVaultNostrDbOwner(ownerPubkey, allowedPubkeys)
    const db = getNostrDb(pubkey)
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
