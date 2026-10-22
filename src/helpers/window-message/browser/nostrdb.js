import { cachedPersonalCopyObfuscation, cachedPersonalCopyObfuscations } from '#services/personal-copy-cache.js'
import { createLocalPersonalCopy } from '#services/idb/nostrdb/personal-copy.js'
import { normalizeLocalRemovalTargets, localRemovalResult } from '#services/idb/nostrdb/local-removal.js'
import { beginNostrDbForegroundIntent } from '#services/idb/nostrdb/access-scheduler.js'
import { isPriorityEventKind } from '#services/vault-request-queue.js'
import { eventKinds } from '#constants/event.js'
import {
  BROAD_EVENT_KIND,
  eventAccessPermissionRequestsForEvent,
  eventAccessPermissionRequestsForKind,
  eventAccessPersonalPermission,
  normalizeEventKind
} from './event-permissions.js'
import { NOSTRDB_ONE_SHOT_METHODS, NOSTRDB_RECOVERY_READ } from '../nostrdb-protocol.js'
import {
  PERSONAL_COPY_KIND,
  isPersonalCopyEvent,
  personalCopyEncryptionKind,
  personalCopyHintKinds,
  plaintextArrayBuffer
} from '#helpers/personal-copy.js'

export const NOSTRDB_MERGE_CONTEXT = 'nostrdb_merge'
export const NOSTRDB_MAINTENANCE_CONTEXT = 'nostrdb_maintenance'
export const NOSTRDB_PERSONAL_COPY_CONTEXT = 'nostrdb_personal_copy'
export const NIP07_BATCH_CODE = 'NIP07_BATCH'

const textDecoder = new TextDecoder()
const PUBLIC_CHUNK_KIND = 34601
const MAX_PERSONAL_COPY_OBFUSCATIONS = 64
const MAX_PERSONAL_COPY_OBFUSCATION_BYTES = 256 * 1024
const personalCopyEncoder = new TextEncoder()
const RECOVERY_COORDINATE_RE = /^libp2r2p:recovery:(?:seed|grant):[a-f0-9]{64}$/
const RECOVERY_TARGET_RE = /^30078:[0-9a-f]{64}:libp2r2p:recovery:(?:seed|grant):[a-f0-9]{64}$/

export function nostrDbSignMethodForTemplate (event) {
  return event?.tags?.some(tag => Array.isArray(tag) && tag[0] === 'imkc')
    ? 'double_sign_event'
    : 'sign_event'
}

export function buildNostrDbAddOptions (options, { appId, signEvent, onTiming, schedulerClass, signal }) {
  const safeOptions = {
    ...withoutRecoveryOption(options),
    appId,
    mergeSource: 'local',
    ...(onTiming ? { onTiming } : {}),
    signEvent
  }
  delete safeOptions.scheduling
  delete safeOptions.schedulerClass
  if (schedulerClass) safeOptions.schedulerClass = schedulerClass
  if (signal) safeOptions.signal = signal
  return safeOptions
}

function plainOptions (options) {
  return options && typeof options === 'object' && !Array.isArray(options) ? options : {}
}

function withoutRecoveryOption (options) {
  const safe = { ...plainOptions(options) }
  delete safe.recovery
  return safe
}

function withForegroundIntent (db, schedulerClass, { appId, signal }, operation) {
  if (schedulerClass !== 'foreground' || !/^[0-9a-f]{64}$/i.test(db.ownerPubkey || '')) return operation()
  const release = beginNostrDbForegroundIntent({
    owner: db.ownerPubkey,
    stores: ['events'],
    appId,
    signal
  })
  return Promise.resolve().then(operation).finally(release)
}

function normalizedPersonalCopyKind (event) {
  const kind = normalizeEventKind(event?.kind)
  if (kind === PERSONAL_COPY_KIND && Array.isArray(event?.tags)) {
    const hinted = event.tags
      .filter(tag => Array.isArray(tag) && tag[0] === 'k')
      .map(tag => normalizeEventKind(tag[1]))
      .find(hintedKind => hintedKind !== null && isPriorityEventKind(hintedKind))
    return hinted ?? kind
  }
  return kind
}

export function isRecoveryArchiveEvent (event, recoveryHint) {
  if (recoveryHint !== true || !event || typeof event !== 'object' || !Array.isArray(event.tags)) return false
  if (event.content !== '') return false
  const kind = normalizeEventKind(event.kind)
  if (kind === eventKinds.CUSTOM_APP_DATA) {
    const coordinate = event.tags.find(tag => Array.isArray(tag) && tag[0] === 'd')?.[1]
    return typeof coordinate === 'string' && RECOVERY_COORDINATE_RE.test(coordinate)
  }
  if (kind !== eventKinds.DELETION) return false
  const innerKinds = event.tags
    .filter(tag => Array.isArray(tag) && tag[0] === 'k')
    .map(tag => normalizeEventKind(tag[1]))
  const targets = event.tags
    .filter(tag => Array.isArray(tag) && tag[0] === 'a')
    .map(tag => typeof tag[1] === 'string' ? tag[1] : '')
  return innerKinds.includes(eventKinds.CUSTOM_APP_DATA) &&
    targets.some(target => RECOVERY_TARGET_RE.test(target))
}

export function isRecoveryReadQuery (params = []) {
  const args = Array.isArray(params) ? params : []
  const filters = Array.isArray(args[0]) ? args[0] : [args[0]]
  if (filters.length !== 1 || !filters[0] || typeof filters[0] !== 'object' || Array.isArray(filters[0])) return false
  const filter = filters[0]
  const kinds = Array.isArray(filter.kinds) ? filter.kinds.map(normalizeEventKind) : []
  const authors = Array.isArray(filter.authors) ? filter.authors : []
  if (kinds.length !== 1 || kinds[0] !== PERSONAL_COPY_KIND || authors.length !== 1 || !/^[0-9a-f]{64}$/i.test(authors[0] || '')) return false
  const tagNames = Object.keys(filter).filter(key => key.startsWith('#') || key.startsWith('&')).map(key => key.slice(1))
  const hasRecordMirror = tagNames.includes('o')
  const kindsAreRecovery = Array.isArray(filter['#k']) &&
    filter['#k'].length > 0 &&
    filter['#k'].every(kind => String(kind) === String(eventKinds.CUSTOM_APP_DATA))
  const allowedTags = new Set(['k', 'c', 'v', 'o', 'D'])
  if (tagNames.some(name => !allowedTags.has(name))) return false
  if (kindsAreRecovery) return tagNames.some(name => ['c', 'v', 'o'].includes(name))
  return hasRecordMirror && !tagNames.includes('k') && !tagNames.includes('c') && !tagNames.includes('v')
}

export function classifyNostrDbWrite (method, params = []) {
  const args = Array.isArray(params) ? params : []
  if (method === 'remove') return 'foreground'
  if (method !== 'add' && method !== 'addPersonalCopy') return 'normal'
  const event = args[0]
  const options = plainOptions(args[1])
  if (isRecoveryArchiveEvent(event, options.recovery === true)) return 'background'
  return isPriorityEventKind(normalizedPersonalCopyKind(event)) ? 'foreground' : 'normal'
}

export function classifyNostrDbRead (method, params = []) {
  const args = Array.isArray(params) ? params : []
  if (method !== 'query') return undefined
  return plainOptions(args[1]).recovery === true && isRecoveryReadQuery(args) ? 'background' : undefined
}

export function buildNostrDbReadOptions (options, { appId, deferCacheAccess, schedulerClass, signal, recoveryRead = false }) {
  const safeOptions = {
    ...(options && typeof options === 'object' && !Array.isArray(options) ? options : {}),
    ...(appId === undefined ? {} : { appId }),
    ...(deferCacheAccess ? { deferCacheAccess: true } : {})
  }
  delete safeOptions.scheduling
  delete safeOptions.schedulerClass
  delete safeOptions.signal
  delete safeOptions.recovery
  delete safeOptions[NOSTRDB_RECOVERY_READ]
  if (schedulerClass) safeOptions.schedulerClass = schedulerClass
  if (signal) safeOptions.signal = signal
  if (recoveryRead) safeOptions[NOSTRDB_RECOVERY_READ] = true
  return safeOptions
}

export function nostrDbReadParamsWithAppId (params = [], { appId, deferCacheAccess, schedulerClass, signal, recoveryRead = false } = {}) {
  const args = Array.isArray(params) ? [...params] : []
  if (appId === undefined && !schedulerClass && !signal && !recoveryRead) return args

  return [
    args[0],
    buildNostrDbReadOptions(args[1], { appId, deferCacheAccess, schedulerClass, signal, recoveryRead })
  ]
}

export function createNostrDbSignEvent ({
  askNip07,
  askVault,
  pubkey,
  app,
  isDefaultUser = false,
  isReadOnly = false,
  isLocked = false,
  onSignerRequestAttention
}) {
  return async event => {
    const resolvedApp = typeof app === 'function' ? await app() : app
    const { payload, error } = await askNip07(askVault, pubkey, {
      ns: [''],
      method: nostrDbSignMethodForTemplate(event),
      params: [event],
      context: NOSTRDB_MERGE_CONTEXT
    }, {
      app: resolvedApp,
      isDefaultUser,
      isReadOnly,
      isLocked,
      onSignerRequestAttention
    })
    if (error) throw error
    return payload
  }
}

export function createNostrDbMaintenanceSignEvent ({ askVault, pubkey, timeoutMs = 120000, guard }) {
  return async event => {
    guard?.({ method: nostrDbSignMethodForTemplate(event), params: [event] })
    const { payload, error } = await askVault({
      code: 'NIP07',
      payload: {
        pubkey,
        ns: [''],
        method: nostrDbSignMethodForTemplate(event),
        params: [event],
        context: NOSTRDB_MAINTENANCE_CONTEXT
      }
    }, { timeout: timeoutMs })
    if (error) throw error
    return payload
  }
}

export function createNostrDbPersonalCopyDecrypt ({ askVault, pubkey, guard }) {
  return async event => {
    const kind = personalCopyEncryptionKind(event)
    if (kind === null) throw new Error('PERSONAL_COPY_KIND_REQUIRED')
    const params = [pubkey, String(kind), '', event?.content]
    guard?.({ method: 'nip44v3_decrypt', params })
    const { payload, error } = await askVault({
      code: 'NIP07',
      payload: {
        pubkey,
        ns: [''],
        method: 'nip44v3_decrypt',
        params,
        context: NOSTRDB_PERSONAL_COPY_CONTEXT
      }
    }, { timeout: 120000 })
    if (error) throw error
    return textDecoder.decode(payload)
  }
}

export function createNostrDbPersonalCopyEncrypt ({ askVault, pubkey, guard }) {
  return async (kind, plaintext) => {
    const params = [pubkey, String(kind), '', plaintextArrayBuffer(plaintext)]
    guard?.({ method: 'nip44v3_encrypt', params })
    const { payload, error } = await askVault({
      code: 'NIP07',
      payload: {
        pubkey,
        ns: [''],
        method: 'nip44v3_encrypt',
        params,
        context: NOSTRDB_PERSONAL_COPY_CONTEXT
      }
    }, { timeout: 120000 })
    if (error) throw error
    return payload
  }
}

export function createNostrDbPersonalCopyObfuscate ({ askVault, pubkey, guard, cacheObfuscation = false, diagnostics }) {
  return async (value, kind, scope) => {
    const params = [value, String(kind), scope]
    const operation = async () => askPersonalCopyObfuscation({ askVault, pubkey, guard, params })
    const result = cacheObfuscation
      ? await cachedPersonalCopyObfuscation(pubkey, value, String(kind), scope, operation, diagnostics)
      : await operation()
    guard?.({ method: 'obfuscate', params })
    return result
  }
}

export function createNostrDbPersonalCopyObfuscateMany ({ askVault, pubkey, guard, diagnostics }) {
  return async operations => cachedPersonalCopyObfuscations(pubkey, operations, async pending => {
    const params = pending.map(({ value, kind, scope }) => [value, String(kind), scope])
    validatePersonalCopyObfuscationBatch(params)
    for (const operation of params) guard?.({ method: 'obfuscate', params: operation })
    try {
      const { payload, error } = await askVault({
        code: NIP07_BATCH_CODE,
        payload: {
          pubkey,
          method: 'obfuscateMany',
          operations: params,
          context: NOSTRDB_PERSONAL_COPY_CONTEXT
        }
      }, { timeout: 120000 })
      if (error) throw error
      if (!Array.isArray(payload) || payload.length !== pending.length || payload.some(value => typeof value !== 'string')) {
        throw new Error('PERSONAL_COPY_OBFUSCATE_BATCH_INVALID_RESULT')
      }
      return payload
    } catch (error) {
      if (error?.code !== 'UNSUPPORTED_METHOD') throw error
      return runLimited(params, 4, operation => askPersonalCopyObfuscation({ askVault, pubkey, guard, params: operation }))
    }
  }, diagnostics)
}

async function askPersonalCopyObfuscation ({ askVault, pubkey, guard, params }) {
  guard?.({ method: 'obfuscate', params })
  const { payload, error } = await askVault({
    code: 'NIP07',
    payload: {
      pubkey,
      ns: [''],
      method: 'obfuscate',
      params,
      context: NOSTRDB_PERSONAL_COPY_CONTEXT
    }
  }, { timeout: 120000 })
  if (error) throw error
  return payload
}

async function runLimited (values, limit, operation) {
  const results = new Array(values.length)
  let index = 0
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) {
      const current = index++
      results[current] = await operation(values[current])
    }
  })
  await Promise.all(workers)
  return results
}

export function validatePersonalCopyObfuscationBatch (params) {
  if (!Array.isArray(params) || !params.length || params.length > MAX_PERSONAL_COPY_OBFUSCATIONS) {
    throw new Error('INVALID_PERSONAL_COPY_OBFUSCATION_BATCH')
  }
  let bytes = 0
  for (const operation of params) {
    if (!Array.isArray(operation) || operation.length !== 3 || typeof operation[0] !== 'string' || typeof operation[2] !== 'string') {
      throw new Error('INVALID_PERSONAL_COPY_OBFUSCATION_BATCH')
    }
    bytes += personalCopyEncoder.encode(operation[0]).byteLength + personalCopyEncoder.encode(operation[2]).byteLength
    if (bytes > MAX_PERSONAL_COPY_OBFUSCATION_BYTES) throw new Error('PERSONAL_COPY_OBFUSCATION_BATCH_TOO_LARGE')
  }
  return params
}

export function nostrDbMaintenanceOptions (signEvent) {
  return typeof signEvent === 'function'
    ? { maintenanceOptions: { signEvent } }
    : {}
}

function normalizeFilterKind (kind) {
  return Number.isInteger(kind) && kind >= 0 && kind <= 0xffffffff ? kind : null
}

function normalizeFilterKinds (value) {
  if (!Array.isArray(value)) return null
  return [...new Set(value.map(normalizeFilterKind).filter(kind => kind !== null))]
    .sort((a, b) => a - b)
}

function normalizeFilterEventKinds (value) {
  if (!Array.isArray(value)) return null
  return [...new Set(value.map(kind => normalizeEventKind(kind)).filter(kind => kind !== null))]
    .sort((a, b) => a - b)
}

export function explicitFilterKinds (filterOrFilters) {
  const filters = Array.isArray(filterOrFilters) ? filterOrFilters : [filterOrFilters]
  if (filters.length === 0) return []

  const kinds = new Set()
  for (const filter of filters) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null
    if (!Object.prototype.hasOwnProperty.call(filter, 'kinds')) return null

    const filterKinds = normalizeFilterKinds(filter.kinds)
    if (filterKinds === null) return null
    for (const kind of filterKinds) kinds.add(kind)
  }

  return [...kinds].sort((a, b) => a - b)
}

function explicitPersonalCopyKinds (filterOrFilters, explicitKinds) {
  if (explicitKinds === null) return null
  if (!explicitKinds.includes(PERSONAL_COPY_KIND)) return []

  const filters = Array.isArray(filterOrFilters) ? filterOrFilters : [filterOrFilters]
  const kinds = new Set()

  for (const filter of filters) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null
    const filterKinds = normalizeFilterKinds(filter.kinds)
    if (filterKinds === null || !filterKinds.includes(PERSONAL_COPY_KIND)) continue
    if (!Object.prototype.hasOwnProperty.call(filter, '#k')) return null

    const filterKTags = normalizeFilterEventKinds(filter['#k'])
    if (filterKTags === null) return null
    for (const kind of filterKTags) kinds.add(kind)
  }

  return [...kinds].sort((a, b) => a - b)
}

function explicitPermissionInfoFromParams (params = []) {
  const filterOrFilters = Array.isArray(params) ? params[0] : undefined
  const explicitKinds = explicitFilterKinds(filterOrFilters)
  return {
    explicitKinds,
    explicitPersonalKinds: explicitPersonalCopyKinds(filterOrFilters, explicitKinds)
  }
}

function normalExplicitKinds (explicitKinds) {
  return (explicitKinds ?? []).filter(kind => kind !== PERSONAL_COPY_KIND && kind !== PUBLIC_CHUNK_KIND)
}

function mayIncludeNormalEvents (explicitKinds) {
  return explicitKinds === null || explicitKinds.some(kind => kind !== PERSONAL_COPY_KIND)
}

function mayIncludePersonalCopies (explicitKinds) {
  return explicitKinds === null || explicitKinds.includes(PERSONAL_COPY_KIND)
}

function resultKind (result) {
  return Number.isInteger(result?.kind) && result.kind >= 0 && result.kind <= 0xffffffff
    ? result.kind
    : null
}

function personalCopyInnerKinds (result) {
  return personalCopyHintKinds(result)
}

function resultPermissionRequests (result, { mayIncludeNormal, mayIncludePersonal }) {
  const kind = resultKind(result)
  if (kind === PERSONAL_COPY_KIND) {
    const innerKinds = personalCopyInnerKinds(result)
    return innerKinds.length > 0
      ? innerKinds.map(kind => eventAccessPersonalPermission(kind))
      : [eventAccessPersonalPermission(BROAD_EVENT_KIND)]
  }

  if (kind === null) {
    return [
      ...(mayIncludeNormal ? eventAccessPermissionRequestsForKind(BROAD_EVENT_KIND) : []),
      ...(mayIncludePersonal ? [eventAccessPersonalPermission(BROAD_EVENT_KIND)] : [])
    ]
  }

  if (kind === PUBLIC_CHUNK_KIND) return []

  return eventAccessPermissionRequestsForKind(kind)
}

function queryResultPermissionRequests (payload, { explicitKinds }) {
  const results = Array.isArray(payload?.results) ? payload.results : []
  return results.flatMap(result => resultPermissionRequests(result, {
    mayIncludeNormal: mayIncludeNormalEvents(explicitKinds),
    mayIncludePersonal: mayIncludePersonalCopies(explicitKinds)
  }))
}

function permissionKey (permission) {
  return `${permission.name}:${permission.eKind}`
}

function uniquePermissions (permissions) {
  const seen = new Set()
  const result = []
  for (const permission of permissions) {
    const key = permissionKey(permission)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(permission)
  }
  return result
}

async function requestPermissions (permissions, { app, requestPermission, params }) {
  if (!requestPermission) return
  for (const permission of uniquePermissions(permissions)) {
    await requestPermission({
      app,
      ...permission,
      meta: {
        params,
        ...permission.meta
      }
    })
  }
}

async function requestAccessKinds (kinds, context) {
  await requestPermissions(kinds.flatMap(kind => eventAccessPermissionRequestsForKind(kind)), context)
}

async function requestPersonalKinds (kinds, context) {
  await requestPermissions(kinds.map(kind => eventAccessPersonalPermission(kind)), context)
}

async function requestPermissionsForQueryResult (payload, context, { explicitKinds }) {
  await requestPermissions(queryResultPermissionRequests(payload, { explicitKinds }), context)
}

export function createNostrDbSubscriptionAuthorizer ({ app, requestPermission, params = [] }) {
  const { explicitKinds, explicitPersonalKinds } = explicitPermissionInfoFromParams(params)
  const granted = new Set()
  const context = { app, requestPermission, params }

  async function requestOnce (permissions) {
    const pending = uniquePermissions(permissions).filter(permission => !granted.has(permissionKey(permission)))
    await requestPermissions(pending, context)
    for (const permission of pending) granted.add(permissionKey(permission))
  }

  return {
    async authorizeBeforeStart () {
      if (explicitKinds === null) {
        await requestOnce([
          ...eventAccessPermissionRequestsForKind(BROAD_EVENT_KIND),
          eventAccessPersonalPermission(BROAD_EVENT_KIND)
        ])
        return
      }
      await requestOnce(normalExplicitKinds(explicitKinds).flatMap(kind => eventAccessPermissionRequestsForKind(kind)))
      if (explicitPersonalKinds !== null) await requestOnce(explicitPersonalKinds.map(kind => eventAccessPersonalPermission(kind)))
    },
    async authorizeItem (item) {
      if (item?.type !== 'event') return
      if (explicitKinds === null) return
      if (explicitKinds !== null && explicitPersonalKinds !== null) return
      await requestOnce(resultPermissionRequests(item?.event, {
        mayIncludeNormal: mayIncludeNormalEvents(explicitKinds),
        mayIncludePersonal: mayIncludePersonalCopies(explicitKinds)
      }))
    }
  }
}

export async function runNostrDbMethod ({
  db,
  method,
  params = [],
  appId,
  signEvent,
  requestPermission,
  app,
  personalCopyEncrypt,
  personalCopyObfuscate,
  personalCopyObfuscateMany,
  deferCacheAccess = false,
  onTiming,
  assertAccess,
  signal
}) {
  if (!NOSTRDB_ONE_SHOT_METHODS.includes(method)) throw new Error(`Unknown nostrdb method ${method}`)
  const args = Array.isArray(params) ? params : []
  const permissionContext = { app, requestPermission, params: args }

  if (method === 'remove') {
    const targets = normalizeLocalRemovalTargets(args[0])
    if (!targets) return localRemovalResult('invalid')
    await requestPermissions(eventAccessPermissionRequestsForEvent({ kind: 5, tags: targets }), permissionContext)
    assertAccess?.()
    return withForegroundIntent(db, 'foreground', { appId, signal }, () =>
      db.remove(targets, { assertAccess, appId, schedulerClass: 'foreground', signal }))
  }

  if (method === 'add') {
    const [event, options] = args
    if (isPersonalCopyEvent(event)) {
      const kinds = personalCopyHintKinds(event)
      await requestPersonalKinds(kinds.length ? kinds : [BROAD_EVENT_KIND], permissionContext)
    } else {
      await requestPermissions(eventAccessPermissionRequestsForEvent(event), permissionContext)
    }
    const schedulerClass = classifyNostrDbWrite(method, args)
    return withForegroundIntent(db, schedulerClass, { appId, signal }, () =>
      db.add(event, buildNostrDbAddOptions(options, {
        appId,
        signEvent,
        onTiming,
        schedulerClass,
        signal
      })))
  }

  if (method === 'addPersonalCopy') {
    const [originalEvent, options] = args
    const innerKind = normalizeEventKind(originalEvent?.kind)
    if (innerKind === null) throw new Error('INVALID_PERSONAL_COPY_INNER_EVENT')
    await requestPersonalKinds([innerKind], permissionContext)

    const normalizedOptions = plainOptions(options)
    const { context = '', hearsay = false, ...restOptions } = normalizedOptions
    const addOptions = withoutRecoveryOption(restOptions)
    const schedulerClass = classifyNostrDbWrite(method, [originalEvent, options])
    return withForegroundIntent(db, schedulerClass, { appId, signal }, async () => {
      const event = await createLocalPersonalCopy({
        signEvent,
        originalEvent,
        ownerPubkey: db.ownerPubkey,
        context,
        hearsay,
        encrypt: personalCopyEncrypt,
        obfuscate: personalCopyObfuscate,
        ...(personalCopyObfuscateMany ? { obfuscateMany: personalCopyObfuscateMany } : {})
      })
      signal?.throwIfAborted()
      const result = await db.add(event, buildNostrDbAddOptions(addOptions, { appId, signEvent, onTiming, schedulerClass, signal }))
      return { event: result?.storedEvent ?? event, result }
    })
  }

  if (method === 'query') {
    const { explicitKinds, explicitPersonalKinds } = explicitPermissionInfoFromParams(args)
    if (explicitKinds === null) {
      await requestAccessKinds([BROAD_EVENT_KIND], permissionContext)
      await requestPersonalKinds([BROAD_EVENT_KIND], permissionContext)
    } else {
      await requestAccessKinds(normalExplicitKinds(explicitKinds), permissionContext)
      if (explicitPersonalKinds !== null) await requestPersonalKinds(explicitPersonalKinds, permissionContext)
    }

    const schedulerClass = classifyNostrDbRead(method, args)
    const readArgs = nostrDbReadParamsWithAppId(args, {
      appId,
      deferCacheAccess,
      schedulerClass,
      recoveryRead: schedulerClass === 'background',
      signal
    })
    if (onTiming) readArgs[1] = { ...plainOptions(readArgs[1]), onTiming }
    const payload = await db.query(...readArgs)
    if (explicitKinds !== null && explicitPersonalKinds === null) {
      await requestPermissionsForQueryResult(payload, permissionContext, { explicitKinds })
    }
    return payload
  }

  if (method === 'count') {
    const { explicitKinds, explicitPersonalKinds } = explicitPermissionInfoFromParams(args)
    if (explicitKinds !== null) await requestAccessKinds(normalExplicitKinds(explicitKinds), permissionContext)
    else await requestAccessKinds([BROAD_EVENT_KIND], permissionContext)

    if (explicitPersonalKinds !== null) await requestPersonalKinds(explicitPersonalKinds, permissionContext)
    else if (mayIncludePersonalCopies(explicitKinds)) await requestPersonalKinds([BROAD_EVENT_KIND], permissionContext)
    const readArgs = [...args]
    if (onTiming) readArgs[1] = { ...plainOptions(readArgs[1]), onTiming }
    return db.count(...readArgs)
  }

  return db[method](...args)
}
