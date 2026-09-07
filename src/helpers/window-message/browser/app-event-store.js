import { base16ToBase62 } from 'libp2r2p/base62'
import { nostrDbStreamDonePayload } from '../nostrdb-protocol.js'
import { guardSignerRequest } from './signer-guard.js'
import {
  createNostrDbMaintenanceSignEvent,
  createNostrDbPersonalCopyDecrypt,
  createNostrDbPersonalCopyEncrypt,
  createNostrDbPersonalCopyObfuscate,
  createNostrDbSignEvent,
  createNostrDbSubscriptionAuthorizer,
  nostrDbMaintenanceOptions,
  nostrDbReadParamsWithAppId,
  nostrDbSignMethodForTemplate,
  runNostrDbMethod
} from './nostrdb.js'

// Each document owns its subscriptions; account stores remain shared by the launcher.
export function createAppEventStoreBridge ({
  ownerPubkey,
  appId,
  getAppMetadata,
  readPersonaPublicKeys,
  readAccountFlags,
  getNostrDb,
  askVault,
  askNip07,
  requestPermission,
  notifySignerRequestAttention,
  reply,
  isWidget = false,
  reportError = console.error
}) {
  const subscriptions = new Map()
  let disposed = false

  // An explicit invalid target must never fall back to the workspace account.
  function resolveScope (payload) {
    const scoped = Object.hasOwn(payload, 'userPk')
    const pubkey = scoped && typeof payload.userPk === 'string'
      ? payload.userPk.toLowerCase()
      : scoped ? payload.userPk : ownerPubkey
    const assertAvailable = () => {
      if (scoped && (
        typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(pubkey) ||
        !readPersonaPublicKeys().includes(pubkey)
      )) {
        throw Object.assign(new Error('Pubkey is not part of the app active persona'), {
          code: 'PUBKEY_NOT_IN_PERSONA'
        })
      }
    }
    assertAvailable()
    const userPk = base16ToBase62(pubkey, { mode: 'integer', minLength: 43 })
    const onAttention = kind => notifySignerRequestAttention?.({ kind, userPk })
    const guard = ({ method, params }) => guardSignerRequest({
      method, params, account: readAccountFlags(userPk), onAttention
    })
    const permission = async request => {
      assertAvailable()
      await requestPermission?.({
        ...request,
        meta: {
          ...request.meta,
          ...(isWidget ? { isWidget: true } : {}),
          ...(scoped ? { accountUserPk: pubkey } : {})
        }
      })
      assertAvailable()
    }
    return { pubkey, userPk, assertAvailable, guard, onAttention, permission }
  }

  // Cancellation closes idle iterators and prevents pending permissions from starting a stream.
  function stop (subscriptionId, error) {
    const subscription = subscriptions.get(subscriptionId)
    if (!subscription) return
    subscription.cancelled = true
    subscriptions.delete(subscriptionId)
    if (!disposed) {
      reply(subscription.event, {
        ...(error ? { error } : { payload: nostrDbStreamDonePayload(subscriptionId) }),
        isLast: true
      })
    }
    try {
      Promise.resolve(subscription.iterator?.return?.()).catch(reportError)
    } catch (error) { reportError(error) }
  }

  function revalidateSubscriptions () {
    for (const [id, subscription] of subscriptions) {
      try { subscription.scope.assertAvailable() } catch (error) { stop(id, error) }
    }
  }

  function dispose () {
    disposed = true
    for (const id of subscriptions.keys()) stop(id)
  }

  // Recheck access after asynchronous permissions, reads, and each streamed item.
  async function handle (event) {
    if (disposed) return
    const payload = event.data.payload ?? {}
    const { method, params = [], subscriptionId } = payload
    let subscription
    const active = () => !disposed && !subscription?.cancelled
    try {
      const scope = resolveScope(payload)
      if (method === 'subscribe') {
        if (!subscriptionId) throw new Error('NOSTRDB_SUBSCRIPTION_ID_REQUIRED')
        if (subscriptions.has(subscriptionId)) throw new Error('NOSTRDB_SUBSCRIPTION_EXISTS')
        subscription = { event, scope, iterator: null, cancelled: false }
        subscriptions.set(subscriptionId, subscription)
      }
      const app = await getAppMetadata()
      if (!active()) return
      scope.assertAvailable()
      const isDefaultUser = readAccountFlags(scope.userPk).isDefaultUser
      // Cached database callbacks belong to the target account, not this persona or document.
      const signerOptions = { askVault, pubkey: scope.pubkey, guard: scope.guard }
      const maintenanceSignEvent = isDefaultUser ? null : createNostrDbMaintenanceSignEvent(signerOptions)
      const personalCopyDecrypt = isDefaultUser ? null : createNostrDbPersonalCopyDecrypt(signerOptions)
      const personalCopyEncrypt = isDefaultUser ? null : createNostrDbPersonalCopyEncrypt(signerOptions)
      const personalCopyObfuscate = isDefaultUser ? null : createNostrDbPersonalCopyObfuscate(signerOptions)
      const db = getNostrDb(scope.pubkey, {
        ...nostrDbMaintenanceOptions(maintenanceSignEvent),
        ...(personalCopyDecrypt ? { personalCopyDecrypt } : {}),
        ...(personalCopyObfuscate ? { personalCopyObfuscate } : {})
      })
      if (subscription) {
        const authorizer = createNostrDbSubscriptionAuthorizer({ app, requestPermission: scope.permission, params })
        await authorizer.authorizeBeforeStart()
        if (!active()) return
        scope.assertAvailable()
        subscription.iterator = db.subscribe(...nostrDbReadParamsWithAppId(params, { appId }))
        for await (const item of subscription.iterator) {
          if (!active()) return
          scope.assertAvailable()
          await authorizer.authorizeItem(item)
          if (!active()) return
          scope.assertAvailable()
          reply(event, { payload: item, isLast: false })
        }
        if (active()) reply(event, { payload: nostrDbStreamDonePayload(subscriptionId), isLast: true })
        return
      }
      const signEvent = async template => {
        scope.assertAvailable()
        scope.guard({ method: nostrDbSignMethodForTemplate(template), params: [template] })
        const signed = await createNostrDbSignEvent({
          askNip07, askVault, pubkey: scope.pubkey, app,
          ...readAccountFlags(scope.userPk), onSignerRequestAttention: scope.onAttention
        })(template)
        scope.assertAvailable()
        return signed
      }
      const result = await runNostrDbMethod({
        db, method, params, appId, signEvent, requestPermission: scope.permission,
        app, personalCopyEncrypt, personalCopyObfuscate
      })
      scope.assertAvailable()
      if (active()) reply(event, { payload: result })
    } catch (error) {
      if (active()) reply(event, { error, ...(method === 'subscribe' ? { isLast: true } : {}) })
    } finally {
      if (subscription && subscriptions.get(subscriptionId) === subscription) subscriptions.delete(subscriptionId)
    }
  }

  return { handle, cancel: stop, revalidateSubscriptions, dispose }
}
