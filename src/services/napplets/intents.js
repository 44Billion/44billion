import { createCatalogIntentResolver, createIntentService, manifestToIntentCatalogEntry } from '@kehto/services'
import { nappletDescriptor } from '#helpers/napplet.js'
import { listInstallations } from './storage.js'
import { NAPPLET_INTENT_DEFAULTS_KEY } from '#constants/storage-schema.js'

// Read current z/i tags explicitly: legacy combined advertisements are not contracts.
export function nappletIntentEntry (event) {
  const { catalogId, manifest } = nappletDescriptor(event)
  const roles = new Set(event.tags.filter(tag => tag[0] === 'z').map(tag => tag[1]))
  const archetypes = event.tags.filter(tag => tag[0] === 'i').flatMap(tag => {
    const match = /^napplet:([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/.exec(tag[1])
    return match && roles.has(match[1]) && tag.slice(2).every(value => typeof value === 'string')
      ? [{ slug: match[1], convention: tag[1], params: tag.slice(2) }]
      : []
  })
  return manifestToIntentCatalogEntry({ catalogId, title: manifest.title, archetypes })
}

export function validIntentDefaults (value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(roles =>
    roles && typeof roles === 'object' && !Array.isArray(roles) && Object.entries(roles).every(([role, id]) =>
      /^[a-z0-9][a-z0-9-]*$/.test(role) && typeof id === 'string' && id.length > 0 && id.length <= 1024))
}

export function createNappletIntentCoordinator ({ wsKey, userPk, storage, openTarget, choose, find, reportError, installations = listInstallations, timeoutMs = 20000 }) {
  const endpoints = new Map()
  const pending = new Set()
  const listeners = new Set()
  const read = key => JSON.parse(storage.getItem(key) || 'null')
  const guard = () => {
    if (read(`session_workspaceByKey_${wsKey}_userPk`) !== userPk) throw new Error('ACCOUNT_ACCESS_REVOKED')
  }
  const defaults = () => { try { const value = read(NAPPLET_INTENT_DEFAULTS_KEY); return validIntentDefaults(value) ? value : {} } catch { return {} } }
  async function catalog () {
    guard()
    const records = await installations()
    guard()
    const ids = new Set([...(read(`session_workspaceByKey_${wsKey}_pinnedAppIds`) || []), ...(read(`session_workspaceByKey_${wsKey}_unpinnedAppIds`) || [])])
    return records.filter(record => ids.has(record.appId)).flatMap(record => {
      try { return [{ ...nappletIntentEntry(record.event), appId: record.appId }] } catch { return [] }
    })
  }
  async function changed () {
    const entries = await catalog()
    const roles = new Set([...listeners].flatMap(item => item.roles || []))
    for (const entry of entries) for (const role of Object.keys(entry.archetypes)) roles.add(role)
    for (const role of roles) {
      const availability = await resolver.available(role)
      for (const listener of listeners) listener.callback(availability)
    }
    for (const listener of listeners) listener.roles = [...roles]
  }
  function settle (job, error) {
    if (!pending.delete(job)) return
    clearTimeout(job.timer)
    if (error) { job.reject(error); reportError?.(error) } else job.resolve()
  }
  function flush () {
    for (const job of pending) {
      if (!job.appKey) continue
      const endpoint = [...endpoints.values()].find(item => item.appKey === job.appKey && item.catalogId === job.params.handler && item.ready)
      if (!endpoint) continue
      try {
        guard()
        endpoint.guard()
        const { sender, archetype, action, convention, payload } = job.params
        endpoint.send({ type: 'intent.deliver', delivery: { sender, archetype, action, convention, ...(payload === undefined ? {} : { payload }) } })
        settle(job)
      } catch (error) { settle(job, error) }
    }
  }
  const targets = {
    accept (params) {
      guard()
      if (params.sourceWindowId) {
        const source = endpoints.get(params.sourceWindowId)
        if (!source) throw new Error('Intent source closed')
        source.guard()
      }
      if (pending.size >= 32) throw new Error('Too many pending intents')
      const snapshot = structuredClone(params)
      const job = { params: snapshot }
      const completion = new Promise((resolve, reject) => { Object.assign(job, { resolve, reject }) })
      pending.add(job)
      job.timer = setTimeout(() => settle(job, new Error('Intent target did not become ready')), timeoutMs)
      // Start independently of the source endpoint; accepted work outlives it.
      Promise.resolve().then(async () => {
        const entry = (await catalog()).find(entry => entry.id === snapshot.handler && entry.archetypes[snapshot.archetype]?.contracts.some(contract => contract.convention === snapshot.convention))
        if (!entry) throw new Error('Intent handler is no longer installed')
        guard()
        job.appKey = await openTarget(entry.appId, snapshot.behavior || {})
        if (pending.has(job)) flush()
      }).catch(error => settle(job, error))
      return { completion }
    }
  }
  const resolverOptions = {
    loadCatalog: catalog, targets,
    getDefaultHandler: role => defaults()[userPk]?.[role],
    chooseHandler: async (role, candidates) => {
      const selected = await choose({ role, candidates, setDefault: id => setDefault(role, id) })
      guard()
      return selected
    },
    authorizeExplicitHandler: async (_sender, id, request, candidate) =>
      (await choose({ role: request.archetype, candidates: [candidate] })) === id
  }
  const resolver = createCatalogIntentResolver(resolverOptions)
  function setDefault (role, id) {
    guard()
    const value = defaults()
    const roles = { ...value[userPk] }
    if (id) roles[role] = id
    else delete roles[role]
    storage.setItem(NAPPLET_INTENT_DEFAULTS_KEY, JSON.stringify({ ...value, [userPk]: roles }))
    changed().catch(() => {})
  }
  return {
    setDefault,
    changed,
    service ({ windowId, appKey, event, send, guard: guardEndpoint }) {
      const catalogId = nappletDescriptor(event).catalogId
      const endpoint = { appKey, catalogId, send, guard: guardEndpoint, ready: false }
      let invocationTimes = []
      const lifetime = new AbortController()
      endpoints.set(windowId, endpoint)
      const endpointResolver = createCatalogIntentResolver({
        ...resolverOptions,
        chooseHandler: async (role, candidates) => {
          guardEndpoint()
          const selected = await choose({ role, candidates, signal: lifetime.signal, setDefault: id => { guardEndpoint(); setDefault(role, id) } })
          guardEndpoint()
          return selected
        },
        authorizeExplicitHandler: async (_sender, id, request, candidate) => {
          guardEndpoint()
          const selected = await choose({ role: request.archetype, candidates: [candidate], signal: lifetime.signal })
          guardEndpoint()
          return selected === id
        }
      })
      const service = createIntentService({
        resolveSender: id => { guardEndpoint(); return endpoints.get(id)?.catalogId },
        resolver: {
          ...resolver,
          available: async role => { guardEndpoint(); return resolver.available(role) },
          handlers: async () => { guardEndpoint(); return resolver.handlers() },
          onChanged: callback => { const item = { callback, roles: [] }; listeners.add(item); return () => listeners.delete(item) },
          async invoke (request, context) {
            guardEndpoint()
            const now = Date.now()
            invocationTimes = invocationTimes.filter(time => now - time < 10000)
            if (invocationTimes.length >= 8) return { ok: false, error: 'invoke rejected' }
            invocationTimes.push(now)
            const result = await endpointResolver.invoke(request, context)
            if (!result.ok && ['no handler', 'unsupported convention', 'unsupported action'].includes(result.error) && (!request.handler || ['default', 'choose'].includes(request.handler))) {
              guardEndpoint()
              // Discovery is not acceptance. The store continuation is a new,
              // explicit user action and does not keep the source RPC pending.
              const retained = structuredClone(request)
              find?.({
                request: retained, sender: catalogId, async continue (handler) {
                  guard()
                  const entry = (await catalog()).find(entry => entry.id === handler && entry.archetypes[retained.archetype]?.contracts.some(contract => contract.convention === retained.convention))
                  if (!entry) throw new Error('Unsupported intent handler')
                  return targets.accept({ ...structuredClone(retained), sender: catalogId, handler }).completion
                }
              })
            }
            return result
          }
        }
      })
      return {
        service,
        ready () { endpoint.ready = true; flush() },
        close () {
          lifetime.abort()
          endpoints.delete(windowId)
          for (const job of pending) if (job.appKey === appKey) settle(job, new Error('Intent target closed'))
        }
      }
    }
  }
}

const coordinators = new Map()
export function getNappletIntentCoordinator (options) {
  const key = JSON.stringify([options.wsKey, options.userPk])
  if (!coordinators.has(key)) coordinators.set(key, createNappletIntentCoordinator(options))
  return coordinators.get(key)
}
