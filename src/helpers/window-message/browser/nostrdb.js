import {
  BROAD_EVENT_KIND,
  eventAccessPermissionRequestsForEvent,
  eventAccessPermissionRequestsForKind,
  eventAccessPersonalPermission,
  normalizeEventKind
} from './event-permissions.js'
import { NOSTRDB_ONE_SHOT_METHODS } from '../nostrdb-protocol.js'
import { base64ToBytes } from '#helpers/base64.js'
import {
  PERSONAL_COPY_KIND,
  buildPersonalCopyUnsignedEvent,
  isPersonalCopyEvent,
  personalCopyEncryptionKind,
  personalCopyHintKinds,
  plaintextBase64
} from '#helpers/personal-copy.js'

export const NOSTRDB_MERGE_CONTEXT = 'nostrdb_merge'
export const NOSTRDB_MAINTENANCE_CONTEXT = 'nostrdb_maintenance'
export const NOSTRDB_PERSONAL_COPY_CONTEXT = 'nostrdb_personal_copy'

const textDecoder = new TextDecoder()

export function nostrDbSignMethodForTemplate (event) {
  return event?.tags?.some(tag => Array.isArray(tag) && tag[0] === 'imkc')
    ? 'double_sign_event'
    : 'sign_event'
}

export function buildNostrDbAddOptions (options, { appId, signEvent }) {
  return {
    ...(options && typeof options === 'object' && !Array.isArray(options) ? options : {}),
    appId,
    mergeSource: 'local',
    signEvent
  }
}

function plainOptions (options) {
  return options && typeof options === 'object' && !Array.isArray(options) ? options : {}
}

export function buildNostrDbReadOptions (options, { appId }) {
  return {
    ...(options && typeof options === 'object' && !Array.isArray(options) ? options : {}),
    ...(appId === undefined ? {} : { appId })
  }
}

export function nostrDbReadParamsWithAppId (params = [], { appId } = {}) {
  const args = Array.isArray(params) ? [...params] : []
  if (appId === undefined) return args

  return [
    args[0],
    buildNostrDbReadOptions(args[1], { appId })
  ]
}

export function createNostrDbSignEvent ({ askNip07, askVault, pubkey, app, isDefaultUser }) {
  return async event => {
    const resolvedApp = typeof app === 'function' ? await app() : app
    const { payload, error } = await askNip07(askVault, pubkey, {
      ns: [''],
      method: nostrDbSignMethodForTemplate(event),
      params: [event],
      context: NOSTRDB_MERGE_CONTEXT
    }, {
      app: resolvedApp,
      isDefaultUser
    })
    if (error) throw error
    return payload
  }
}

export function createNostrDbMaintenanceSignEvent ({ askVault, pubkey }) {
  return async event => {
    const { payload, error } = await askVault({
      code: 'NIP07',
      payload: {
        pubkey,
        ns: [''],
        method: nostrDbSignMethodForTemplate(event),
        params: [event],
        context: NOSTRDB_MAINTENANCE_CONTEXT
      }
    }, { timeout: 120000 })
    if (error) throw error
    return payload
  }
}

export function createNostrDbPersonalCopyDecrypt ({ askVault, pubkey }) {
  return async event => {
    const kind = personalCopyEncryptionKind(event)
    if (kind === null) throw new Error('PERSONAL_COPY_KIND_REQUIRED')
    const { payload, error } = await askVault({
      code: 'NIP07',
      payload: {
        pubkey,
        ns: [''],
        method: 'nip44v3_decrypt',
        params: [pubkey, String(kind), '', event?.content],
        context: NOSTRDB_PERSONAL_COPY_CONTEXT
      }
    }, { timeout: 120000 })
    if (error) throw error
    return textDecoder.decode(base64ToBytes(String(payload ?? '')))
  }
}

export function createNostrDbPersonalCopyEncrypt ({ askVault, pubkey }) {
  return async (kind, plaintext) => {
    const { payload, error } = await askVault({
      code: 'NIP07',
      payload: {
        pubkey,
        ns: [''],
        method: 'nip44v3_encrypt',
        params: [pubkey, String(kind), '', plaintextBase64(plaintext)],
        context: NOSTRDB_PERSONAL_COPY_CONTEXT
      }
    }, { timeout: 120000 })
    if (error) throw error
    return payload
  }
}

export function createNostrDbPersonalCopyObfuscate ({ askVault, pubkey }) {
  return async (value, kind, scope) => {
    const { payload, error } = await askVault({
      code: 'NIP07',
      payload: {
        pubkey,
        ns: [''],
        method: 'obfuscate',
        params: [value, String(kind), scope],
        context: NOSTRDB_PERSONAL_COPY_CONTEXT
      }
    }, { timeout: 120000 })
    if (error) throw error
    return payload
  }
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

function explicitLocalCopyKinds (filterOrFilters, explicitKinds) {
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
    explicitPersonalKinds: explicitLocalCopyKinds(filterOrFilters, explicitKinds)
  }
}

function normalExplicitKinds (explicitKinds) {
  return (explicitKinds ?? []).filter(kind => kind !== PERSONAL_COPY_KIND)
}

function mayIncludeNormalEvents (explicitKinds) {
  return explicitKinds === null || explicitKinds.some(kind => kind !== PERSONAL_COPY_KIND)
}

function mayIncludeLocalCopies (explicitKinds) {
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

  return eventAccessPermissionRequestsForKind(kind)
}

function queryResultPermissionRequests (payload, { explicitKinds }) {
  const results = Array.isArray(payload?.results) ? payload.results : []
  return results.flatMap(result => resultPermissionRequests(result, {
    mayIncludeNormal: mayIncludeNormalEvents(explicitKinds),
    mayIncludePersonal: mayIncludeLocalCopies(explicitKinds)
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
      if (explicitKinds !== null) await requestOnce(normalExplicitKinds(explicitKinds).flatMap(kind => eventAccessPermissionRequestsForKind(kind)))
      if (explicitPersonalKinds !== null) await requestOnce(explicitPersonalKinds.map(kind => eventAccessPersonalPermission(kind)))
    },
    async authorizeItem (item) {
      if (explicitKinds !== null && explicitPersonalKinds !== null) return
      await requestOnce(resultPermissionRequests(item?.result, {
        mayIncludeNormal: mayIncludeNormalEvents(explicitKinds),
        mayIncludePersonal: mayIncludeLocalCopies(explicitKinds)
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
  personalCopyObfuscate
}) {
  if (!NOSTRDB_ONE_SHOT_METHODS.includes(method)) throw new Error(`Unknown nostrdb method ${method}`)
  const args = Array.isArray(params) ? params : []
  const permissionContext = { app, requestPermission, params: args }

  if (method === 'add') {
    const [event, options] = args
    if (isPersonalCopyEvent(event)) {
      const kinds = personalCopyHintKinds(event)
      await requestPersonalKinds(kinds.length ? kinds : [BROAD_EVENT_KIND], permissionContext)
    } else {
      await requestPermissions(eventAccessPermissionRequestsForEvent(event), permissionContext)
    }
    return db.add(event, buildNostrDbAddOptions(options, { appId, signEvent }))
  }

  if (method === 'addPersonalCopy') {
    const [originalEvent, options] = args
    const innerKind = normalizeEventKind(originalEvent?.kind)
    if (innerKind === null) throw new Error('INVALID_PERSONAL_COPY_INNER_EVENT')
    await requestPersonalKinds([innerKind], permissionContext)

    const normalizedOptions = plainOptions(options)
    const { context = '', ...addOptions } = normalizedOptions
    const unsigned = await buildPersonalCopyUnsignedEvent({
      originalEvent,
      ownerPubkey: db.ownerPubkey,
      context,
      encrypt: personalCopyEncrypt,
      obfuscate: personalCopyObfuscate
    })
    const event = await signEvent(unsigned)
    const result = await db.add(event, buildNostrDbAddOptions(addOptions, { appId, signEvent }))
    return { event, result }
  }

  if (method === 'query') {
    const { explicitKinds, explicitPersonalKinds } = explicitPermissionInfoFromParams(args)
    if (explicitKinds !== null) await requestAccessKinds(normalExplicitKinds(explicitKinds), permissionContext)
    if (explicitPersonalKinds !== null) await requestPersonalKinds(explicitPersonalKinds, permissionContext)

    const payload = await db.query(...nostrDbReadParamsWithAppId(args, { appId }))
    if (explicitKinds === null || explicitPersonalKinds === null) {
      await requestPermissionsForQueryResult(payload, permissionContext, { explicitKinds })
    }
    return payload
  }

  if (method === 'count') {
    const { explicitKinds, explicitPersonalKinds } = explicitPermissionInfoFromParams(args)
    if (explicitKinds !== null) await requestAccessKinds(normalExplicitKinds(explicitKinds), permissionContext)
    else await requestAccessKinds([BROAD_EVENT_KIND], permissionContext)

    if (explicitPersonalKinds !== null) await requestPersonalKinds(explicitPersonalKinds, permissionContext)
    else if (mayIncludeLocalCopies(explicitKinds)) await requestPersonalKinds([BROAD_EVENT_KIND], permissionContext)
    return db.count(...args)
  }

  return db[method](...args)
}
