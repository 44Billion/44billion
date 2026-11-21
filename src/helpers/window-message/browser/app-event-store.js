import { classifyVaultRequest } from '#services/vault-request-queue.js'
import { withRequestDiagnostics, recordPerformance } from '#services/performance-diagnostics.js'
import { getEventHash } from 'libp2r2p/event'
import { assertNostrDbAccountFlags, assertNostrDbAccess, watchNostrDbAccess } from '#services/idb/nostrdb/access.js'
import { NOSTRDB_CAPABILITIES } from '#services/idb/nostrdb/capabilities.js'
import { base16ToBase62 } from 'libp2r2p/base62'
import {
  NOSTRDB_ONESHOT_TIMEOUT_MS,
  NOSTRDB_REQUEST_CANCELLED,
  NOSTRDB_REQUEST_TIMEOUT,
  NOSTRDB_SNAPSHOT_FIRST_TIMEOUT_MS,
  NOSTRDB_SNAPSHOT_IDLE_TIMEOUT_MS,
  NOSTRDB_SNAPSHOT_TIMEOUT,
  nostrDbStreamDonePayload
} from '../nostrdb-protocol.js'
import { guardSignerRequest } from './signer-guard.js'
import {
  createNostrDbMaintenanceSignEvent,
  createNostrDbPersonalCopyDecrypt,
  createNostrDbPersonalCopyEncrypt,
  createNostrDbPersonalCopyObfuscate,
  createNostrDbPersonalCopyObfuscateMany,
  createNostrDbSignEvent,
  isRecoveryArchiveEvent,
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
  reportError = console.error,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const subscriptions = new Map()
  const operations = new Map()
  let disposed = false
  const stopAccessWatch = watchNostrDbAccess(revalidateSubscriptions)

  function cancelledError () {
    return Object.assign(new Error(NOSTRDB_REQUEST_CANCELLED), { code: NOSTRDB_REQUEST_CANCELLED })
  }

  function requestTimeoutError () {
    return Object.assign(new Error(NOSTRDB_REQUEST_TIMEOUT), { code: NOSTRDB_REQUEST_TIMEOUT })
  }

  function snapshotTimeoutError () {
    return Object.assign(new Error(NOSTRDB_SNAPSHOT_TIMEOUT), { code: NOSTRDB_SNAPSHOT_TIMEOUT })
  }

  // An explicit invalid target must never fall back to the workspace account.
  function resolveScope (payload) {
    const scoped = Object.hasOwn(payload, 'userPk')
    const pubkey = scoped && typeof payload.userPk === 'string'
      ? payload.userPk.toLowerCase()
      : scoped ? payload.userPk : ownerPubkey
    const assertPersona = () => {
      if (scoped && (
        typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(pubkey) ||
        !readPersonaPublicKeys().includes(pubkey)
      )) {
        throw Object.assign(new Error('Pubkey is not part of the app active persona'), {
          code: 'PUBKEY_NOT_IN_PERSONA'
        })
      }
    }
    assertPersona()
    const userPk = base16ToBase62(pubkey, { mode: 'integer', minLength: 43 })
    const assertAvailable = () => {
      assertPersona()
      assertNostrDbAccountFlags(readAccountFlags(userPk))
      assertNostrDbAccess(pubkey)
    }
    const onAttention = kind => notifySignerRequestAttention?.({ kind, userPk })
    const guard = ({ method, params }) => guardSignerRequest({
      method, params, account: readAccountFlags(userPk), onAttention
    })
    const permission = async (request, signal) => {
      const requestSignal = signal || request.signal
      assertAvailable()
      await requestPermission?.({
        ...request,
        signal: requestSignal,
        meta: {
          ...request.meta,
          ...(isWidget ? { isWidget: true } : {}),
          ...(scoped ? { accountUserPk: pubkey } : {})
        }
      })
      assertAvailable()
    }
    return { pubkey, userPk, assertAvailable, assertPersona, guard, onAttention, permission }
  }

  // Cancellation closes idle iterators and prevents pending permissions from starting a stream.
  function stop (subscriptionId, error) {
    const subscription = subscriptions.get(subscriptionId)
    if (!subscription) return
    subscription.cancelled = true
    clearSnapshotTimers(subscription)
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
    for (const operation of operations.values()) {
      try { operation.assertAvailable() } catch (error) { operation.controller.abort(error) }
    }
  }

  function dispose () {
    disposed = true
    stopAccessWatch()
    for (const id of subscriptions.keys()) stop(id)
    const error = cancelledError()
    for (const operation of operations.values()) {
      operation.silent = true
      clearTimer(operation.deadlineTimer)
      operation.controller.abort(error)
    }
    operations.clear()
  }

  function cancel (target) {
    if (typeof target === 'string') {
      stop(target)
      return
    }
    if (typeof target?.requestId === 'string') {
      const operation = operations.get(target.requestId)
      if (operation) {
        operation.silent = true
        clearTimer(operation.deadlineTimer)
        operation.controller.abort(cancelledError())
      }
      return
    }
    stop(target?.subscriptionId)
  }

  function clearSnapshotTimers (subscription) {
    clearTimer(subscription.firstTimer)
    clearTimer(subscription.idleTimer)
    subscription.firstTimer = null
    subscription.idleTimer = null
  }

  function resetSnapshotIdleTimer (subscription) {
    if (!subscription.snapshot || subscription.snapshot.settled) return
    clearTimer(subscription.idleTimer)
    subscription.idleTimer = setTimer(() => stop(subscription.subscriptionId, snapshotTimeoutError()), NOSTRDB_SNAPSHOT_IDLE_TIMEOUT_MS)
    subscription.idleTimer?.unref?.()
  }

  function noteSnapshotProgress (subscription, item) {
    if (!subscription.snapshot || subscription.snapshot.settled) return
    if (item?.type === 'eose') {
      clearSnapshotTimers(subscription)
      subscription.snapshot.settled = true
      return
    }
    if (!subscription.snapshot.firstResultReceived) {
      subscription.snapshot.firstResultReceived = true
      clearTimer(subscription.firstTimer)
      subscription.firstTimer = null
    }
    resetSnapshotIdleTimer(subscription)
  }

  function armSnapshotTimers (subscription, params) {
    const options = params?.[1]
    if (!options || options.initial !== true) return
    subscription.snapshot = { firstResultReceived: false, settled: false }
    subscription.firstTimer = setTimer(
      () => stop(subscription.subscriptionId, snapshotTimeoutError()),
      NOSTRDB_SNAPSHOT_FIRST_TIMEOUT_MS
    )
    subscription.firstTimer?.unref?.()
  }

  function armRequestDeadline (operation, deadlineAt) {
    const queuedAt = now()
    const requested = Number.isFinite(deadlineAt) ? deadlineAt : queuedAt + NOSTRDB_ONESHOT_TIMEOUT_MS
    const deadline = Math.min(requested, queuedAt + NOSTRDB_ONESHOT_TIMEOUT_MS)
    operation.deadlineTimer = setTimer(
      () => operation.controller.abort(requestTimeoutError()),
      Math.max(0, deadline - queuedAt)
    )
    operation.deadlineTimer?.unref?.()
  }

  // Recheck access after asynchronous permissions, reads, and each streamed item.
  async function handle (event) {
    if (disposed) return
    const payload = event.data.payload ?? {}
    const { method, params = [], subscriptionId } = payload
    let subscription
    let operation
    let operationId
    const active = () => !disposed && !subscription?.cancelled && !operation?.silent
    try {
      const scope = resolveScope(payload)
      if (method === 'supports') { reply(event, { payload: [...NOSTRDB_CAPABILITIES] }); return }
      scope.assertAvailable()
      operationId = typeof event.data.reqId === 'string' && event.data.reqId
        ? event.data.reqId
        : Symbol('nostrdb-operation')
      if (operations.has(operationId)) throw new Error('NOSTRDB_REQUEST_ID_REUSED')
      const operationController = new AbortController()
      operation = {
        controller: operationController,
        deadlineTimer: null,
        silent: false,
        assertAvailable: () => {
          if (disposed || subscription?.cancelled || operation.silent) throw cancelledError()
          scope.assertAvailable()
        }
      }
      operations.set(operationId, operation)
      if (method !== 'subscribe') armRequestDeadline(operation, payload.deadlineAt)
      if (method === 'subscribe') {
        if (!subscriptionId) throw new Error('NOSTRDB_SUBSCRIPTION_ID_REQUIRED')
        if (subscriptions.has(subscriptionId)) throw new Error('NOSTRDB_SUBSCRIPTION_EXISTS')
        subscription = {
          event,
          scope,
          iterator: null,
          cancelled: false,
          subscriptionId,
          firstTimer: null,
          idleTimer: null,
          snapshot: null
        }
        armSnapshotTimers(subscription, params)
        subscriptions.set(subscriptionId, subscription)
      }
      const app = await getAppMetadata()
      if (!active()) return
      operationController.signal.throwIfAborted()
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
        ...(personalCopyEncrypt ? { personalCopyEncrypt } : {}),
        ...(personalCopyObfuscate ? { personalCopyObfuscate } : {})
      })
      if (subscription) {
        const readParams = nostrDbReadParamsWithAppId(params, { appId, deferCacheAccess: true })
        subscription.iterator = db.subscribe(...readParams)
        for await (const item of subscription.iterator) {
          if (!active()) return
          scope.assertAvailable()
          reply(event, { payload: item, isLast: false })
          noteSnapshotProgress(subscription, item)
          if (item.type === 'event') db.recordCacheAccess?.(item, ...readParams)
        }
        if (active()) reply(event, { payload: nostrDbStreamDonePayload(subscriptionId), isLast: true })
        return
      }
      let eventId
      let seedRecordId
      if (typeof IS_DEVELOPMENT !== 'undefined' && IS_DEVELOPMENT && method === 'addPersonalCopy') {
        try { eventId = getEventHash({ ...params[0], pubkey: params[0]?.pubkey || scope.pubkey }) } catch {}
        const coordinate = Array.isArray(params[0]?.tags) ? params[0].tags.find(tag => Array.isArray(tag) && tag[0] === 'd')?.[1] : undefined
        if (params[0]?.kind === 30078 && /^libp2r2p:recovery:seed:[a-f0-9]{64}$/.test(coordinate)) seedRecordId = coordinate
      }
      const inherited = method === 'addPersonalCopy'
        ? classifyVaultRequest({ code: 'NIP07', payload: { method: 'signEvent', params: [params[0]] } })
        : undefined
      const archiveRequest = method === 'addPersonalCopy' &&
        isRecoveryArchiveEvent(params[0], params[1]?.recovery === true)
      if (inherited && archiveRequest) inherited.archive = true
      const requestVault = (message, options) => askVault(
        withRequestDiagnostics(message, { reqId: event.data.reqId, eventId, seedRecordId }),
        {
          ...options,
          ...(inherited ? { scheduling: inherited } : {}),
          signal: operationController.signal
        }
      )
      const localSignerOptions = { ...signerOptions, askVault: requestVault, cacheObfuscation: true, diagnostics: { requestId: event.data.reqId, eventId, seedRecordId } }
      const startedAt = performance.now()
      const signEvent = async template => {
        scope.assertAvailable()
        scope.guard({ method: nostrDbSignMethodForTemplate(template), params: [template] })
        const signed = await createNostrDbSignEvent({
          askNip07, askVault: requestVault, pubkey: scope.pubkey, app,
          ...readAccountFlags(scope.userPk), onSignerRequestAttention: scope.onAttention
        })(template)
        scope.assertAvailable()
        return signed
      }
      const result = await runNostrDbMethod({
        db, method, params, appId, signEvent, requestPermission: scope.permission,
        onTiming: typeof IS_DEVELOPMENT !== 'undefined' && IS_DEVELOPMENT ? entry => recordPerformance({ ...entry, eventId, seedRecordId, requestId: event.data.reqId, archive: archiveRequest }) : undefined,
        app, personalCopyEncrypt: isDefaultUser ? null : createNostrDbPersonalCopyEncrypt(localSignerOptions), personalCopyObfuscate: isDefaultUser ? null : createNostrDbPersonalCopyObfuscate(localSignerOptions), personalCopyObfuscateMany: isDefaultUser ? null : createNostrDbPersonalCopyObfuscateMany(localSignerOptions), deferCacheAccess: true,
        signal: operationController.signal,
        assertAccess: () => {
          operationController.signal.throwIfAborted()
          scope.assertAvailable()
          if (!active()) throw cancelledError()
        }
      })
      recordPerformance({ stage: 'event-store', eventId, seedRecordId, requestId: event.data.reqId, archive: archiveRequest, elapsedMs: performance.now() - startedAt })
      operationController.signal.throwIfAborted()
      scope.assertAvailable()
      if (active()) {
        reply(event, { payload: result })
        if (method === 'query') db.recordCacheAccess?.(result, ...nostrDbReadParamsWithAppId(params, { appId }))
      }
    } catch (error) {
      if (active()) reply(event, { error, ...(method === 'subscribe' ? { isLast: true } : {}) })
    } finally {
      if (operation) clearTimer(operation.deadlineTimer)
      if (operationId !== undefined) operations.delete(operationId)
      if (subscription) clearSnapshotTimers(subscription)
      if (subscription && subscriptions.get(subscriptionId) === subscription) subscriptions.delete(subscriptionId)
    }
  }

  return { handle, cancel, revalidateSubscriptions, dispose }
}
