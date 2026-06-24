import {
  BROAD_EVENT_KIND,
  eventReadPermission,
  eventWritePermissionRequestsForEvent
} from './event-permissions.js'
import { NOSTRDB_ONE_SHOT_METHODS } from '../nostrdb-protocol.js'

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

export function createNostrDbSignEvent ({ askNip07, askVault, pubkey, app, isDefaultUser }) {
  return async event => {
    const resolvedApp = typeof app === 'function' ? await app() : app
    const { payload, error } = await askNip07(askVault, pubkey, {
      ns: [''],
      method: nostrDbSignMethodForTemplate(event),
      params: [event],
      context: 'nostrdb_merge'
    }, {
      app: resolvedApp,
      isDefaultUser
    })
    if (error) throw error
    return payload
  }
}

function normalizeFilterKind (kind) {
  return Number.isInteger(kind) && kind >= 0 && kind <= 0xffffffff ? kind : null
}

function normalizeFilterKinds (value) {
  if (!Array.isArray(value)) return null
  return [...new Set(value.map(normalizeFilterKind).filter(kind => kind !== null))]
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

function resultKind (result) {
  return Number.isInteger(result?.kind) && result.kind >= 0 && result.kind <= 0xffffffff
    ? result.kind
    : null
}

function queryResultKinds (payload) {
  const results = Array.isArray(payload?.results) ? payload.results : []
  const kinds = new Set()
  let needsBroadPermission = false

  for (const result of results) {
    const kind = resultKind(result)
    if (kind === null) needsBroadPermission = true
    else kinds.add(kind)
  }

  return {
    kinds: [...kinds].sort((a, b) => a - b),
    needsBroadPermission
  }
}

async function requestPermissions (permissions, { app, requestPermission, params }) {
  if (!requestPermission) return
  for (const permission of permissions) {
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

async function requestReadKinds (kinds, context) {
  await requestPermissions(kinds.map(kind => eventReadPermission(kind)), context)
}

function explicitKindsFromParams (params = []) {
  return explicitFilterKinds(Array.isArray(params) ? params[0] : undefined)
}

async function requestReadForQueryResult (payload, context) {
  const { kinds, needsBroadPermission } = queryResultKinds(payload)
  await requestReadKinds(kinds, context)
  if (needsBroadPermission) await requestReadKinds([BROAD_EVENT_KIND], context)
}

export function createNostrDbSubscriptionAuthorizer ({ app, requestPermission, params = [] }) {
  const explicitKinds = explicitKindsFromParams(params)
  const granted = new Set()
  const context = { app, requestPermission, params }

  async function requestKindOnce (kind) {
    if (granted.has(kind)) return
    await requestReadKinds([kind], context)
    granted.add(kind)
  }

  return {
    async authorizeBeforeStart () {
      if (explicitKinds === null) return
      await requestReadKinds(explicitKinds, context)
      for (const kind of explicitKinds) granted.add(kind)
    },
    async authorizeItem (item) {
      if (explicitKinds !== null) return
      await requestKindOnce(resultKind(item?.result) ?? BROAD_EVENT_KIND)
    }
  }
}

export async function runNostrDbMethod ({ db, method, params = [], appId, signEvent, requestPermission, app }) {
  if (!NOSTRDB_ONE_SHOT_METHODS.includes(method)) throw new Error(`Unknown nostrdb method ${method}`)
  const args = Array.isArray(params) ? params : []
  const permissionContext = { app, requestPermission, params: args }

  if (method === 'add') {
    const [event, options] = args
    await requestPermissions(eventWritePermissionRequestsForEvent(event), permissionContext)
    return db.add(event, buildNostrDbAddOptions(options, { appId, signEvent }))
  }

  if (method === 'query') {
    const explicitKinds = explicitKindsFromParams(args)
    if (explicitKinds !== null) await requestReadKinds(explicitKinds, permissionContext)

    const payload = await db.query(...args)
    if (explicitKinds === null) await requestReadForQueryResult(payload, permissionContext)
    return payload
  }

  if (method === 'count') {
    const explicitKinds = explicitKindsFromParams(args)
    await requestReadKinds(explicitKinds ?? [BROAD_EVENT_KIND], permissionContext)
    return db.count(...args)
  }

  return db[method](...args)
}
