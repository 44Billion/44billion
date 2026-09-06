import { setWebStorageItem } from '#f'

export const SUBDOMAIN_STATE_KEY = 'local_subdomainLifecycle'
export const SUBDOMAIN_LOCK = 'app-subdomain-mappings'
export const isSubdomainStorageKey = key => key.startsWith('session_subdomain') || key === SUBDOMAIN_STATE_KEY
export const subdomainUseLock = id => `app-subdomain-use:${id}`
let fallbackLock = Promise.resolve()

export function withSubdomainLock (fn) {
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request(SUBDOMAIN_LOCK, async () => {
      try { return { value: await fn() } } catch (error) { return { error } }
    }).then(result => {
      if (result.error) throw result.error
      return result.value
    })
  }
  const result = fallbackLock.then(fn)
  fallbackLock = result.catch(() => {})
  return result
}

// Read the actual storage while holding the lock, not a reactive snapshot that
// may still be awaiting a storage event from another tab.
export function subdomainStorage (area = globalThis.localStorage, write = setWebStorageItem) {
  return new Proxy({}, {
    get (_, property) {
      if (property === 'keys') return () => Array.from({ length: area.length }, (_, i) => area.key(i)).filter(key => typeof key === 'string')
      if (typeof property !== 'string' || !property.endsWith('$')) return undefined
      const key = property.slice(0, -1)
      return (...args) => {
        if (args.length) return write(area, key, args[0])
        try { return JSON.parse(area.getItem(key)) ?? undefined } catch { return undefined }
      }
    }
  })
}

function normalizeSubdomainId (value) {
  const id = String(value ?? '')
  if (!/^\d+$/.test(id)) return ''
  const number = Number(id)
  return Number.isSafeInteger(number) && number >= 0 ? String(number) : ''
}

export function normalizeSubdomainFreeIds (value) {
  return [...new Set((Array.isArray(value) ? value : []).map(normalizeSubdomainId).filter(Boolean))]
    .sort((a, b) => Number(a) - Number(b))
}

export function addSubdomainFreeId (freeIds, subdomain) {
  return normalizeSubdomainFreeIds([...(Array.isArray(freeIds) ? freeIds : []), subdomain])
}

export function readSubdomainLifecycle (storage) {
  const value = storage.local_subdomainLifecycle$()
  return {
    version: 1,
    pending: normalizeSubdomainFreeIds(value?.pending),
    assignments: value?.assignments && typeof value.assignments === 'object' && !Array.isArray(value.assignments) ? { ...value.assignments } : {}
  }
}

export function initializeSubdomainLifecycle (storage) {
  const old = storage.local_subdomainLifecycle$()
  const state = readSubdomainLifecycle(storage)
  if (old?.version !== 1) {
    state.pending = normalizeSubdomainFreeIds([...state.pending, ...normalizeSubdomainFreeIds(storage.session_subdomainFreeIds$())])
    // Persist quarantine before discarding the old, unverified free list.
    storage.local_subdomainLifecycle$(state)
    storage.session_subdomainFreeIds$(undefined)
  }
  return state
}

function knownIds (storage, state) {
  const keys = storage.keys?.() ?? []
  return normalizeSubdomainFreeIds([
    ...keys.filter(key => key.startsWith('session_subdomainToApp_')).map(key => key.slice('session_subdomainToApp_'.length)),
    ...keys.filter(key => key.startsWith('session_subdomainByUserAndApp_')).map(key => storage[`${key}$`]()),
    ...state.pending, ...Object.keys(state.assignments), ...normalizeSubdomainFreeIds(storage.session_subdomainFreeIds$())
  ])
}

export function isSubdomainMapped (storage, id) {
  return storage[`session_subdomainToApp_${id}$`]() != null ||
    (storage.keys?.() ?? []).some(key => key.startsWith('session_subdomainByUserAndApp_') && String(storage[`${key}$`]()) === String(id))
}

// Called under the mapping lock, before rendering and during maintenance.
// Read current mappings here rather than applying an earlier audit snapshot.
export function normalizeSubdomainMaintenance (storage) {
  const state = initializeSubdomainLifecycle(storage)
  const free = normalizeSubdomainFreeIds(storage.session_subdomainFreeIds$())
  const queued = []
  for (const [id, token] of Object.entries(state.assignments)) {
    if (normalizeSubdomainId(id) !== id || typeof token !== 'string' || !token) continue
    if (state.pending.includes(id) || free.includes(id) || isSubdomainMapped(storage, id)) continue
    queued.push(id)
  }
  if (queued.length) {
    state.pending = normalizeSubdomainFreeIds([...state.pending, ...queued])
    storage.local_subdomainLifecycle$(state)
  }
  const nextId = storage.session_subdomainNextId$()
  const minimumNext = knownIds(storage, state).reduce((max, id) => Math.max(max, Number(id) + 1), 0)
  const invalidCounter = nextId !== undefined && (!Number.isSafeInteger(nextId) || nextId < 0)
  const advanceCounter = minimumNext > 0 && (!Number.isSafeInteger(nextId) || nextId < minimumNext)
  const updateCounter = Number.isSafeInteger(minimumNext) && (invalidCounter || advanceCounter)
  if (updateCounter) storage.session_subdomainNextId$(minimumNext)
  if (queued.length || updateCounter) {
    console.info('[subdomain-maintenance] Normalized without reload', {
      queued, nextId: updateCounter ? minimumNext : nextId
    })
  }
  return state
}

export async function allocateAppSubdomain (storage, { userPk, appId }) {
  if (!storage || !userPk || !appId) return ''
  return withSubdomainLock(() => {
    const state = initializeSubdomainLifecycle(storage)
    const current = storage[`session_subdomainByUserAndApp_${userPk}_${appId}$`]()
    if (current != null) {
      const reverse = storage[`session_subdomainToApp_${current}$`]()
      if (reverse != null && (reverse.appId !== appId || reverse.userPk !== userPk)) throw new Error(`App subdomain ${current} is mapped to another app/user`)
      if (reverse == null) storage[`session_subdomainToApp_${current}$`]({ appId, userPk })
      return current
    }
    const nextId = Number(storage.session_subdomainNextId$() ?? 0)
    const ids = knownIds(storage, state)
    // Legacy/test adapters need not enumerate keys.
    const candidates = storage.keys ? ids : Array.from({ length: Number.isSafeInteger(nextId) && nextId >= 0 ? nextId : 0 }, (_, i) => String(i))
    for (const id of candidates) {
      const reverse = storage[`session_subdomainToApp_${id}$`]()
      if (reverse?.appId === appId && reverse?.userPk === userPk) {
        storage[`session_subdomainByUserAndApp_${userPk}_${appId}$`](id)
        return id
      }
    }
    const free = normalizeSubdomainFreeIds(storage.session_subdomainFreeIds$())
    // Without cross-tab exclusion, never consume a recycled origin.
    let id = globalThis.navigator?.locks?.request
      ? free.find(id => !state.pending.includes(id) && !isSubdomainMapped(storage, id))
      : null
    if (id != null) storage.session_subdomainFreeIds$(free.filter(item => item !== id))
    else {
      const maximum = ids.reduce((max, id) => Math.max(max, Number(id) + 1), 0)
      id = String(Math.max(Number.isSafeInteger(nextId) && nextId >= 0 ? nextId : 0, maximum))
      while (storage[`session_subdomainToApp_${id}$`]() != null) id = String(Number(id) + 1)
      if (!Number.isSafeInteger(Number(id) + 1)) throw new Error('Subdomain IDs exhausted')
      storage.session_subdomainNextId$(Number(id) + 1)
    }
    state.assignments[id] = crypto.randomUUID()
    storage.local_subdomainLifecycle$(state)
    storage[`session_subdomainToApp_${id}$`]({ appId, userPk })
    storage[`session_subdomainByUserAndApp_${userPk}_${appId}$`](id)
    return id
  })
}

// Called under the mapping lock. Quarantine is durable before mappings disappear.
export function retireSubdomain (storage, id) {
  id = normalizeSubdomainId(id)
  if (!id) return false
  const state = initializeSubdomainLifecycle(storage)
  state.pending = addSubdomainFreeId(state.pending, id)
  storage.local_subdomainLifecycle$(state)
  storage.session_subdomainFreeIds$(normalizeSubdomainFreeIds(storage.session_subdomainFreeIds$()).filter(value => value !== id))
  const mapping = storage[`session_subdomainToApp_${id}$`]()
  if (mapping && storage[`session_subdomainByUserAndApp_${mapping.userPk}_${mapping.appId}$`]() === id) {
    storage[`session_subdomainByUserAndApp_${mapping.userPk}_${mapping.appId}$`](undefined)
  }
  storage[`session_subdomainToApp_${id}$`](undefined)
  return true
}

export async function releaseAppSubdomain (storage, { userPk, appId, subdomain }) {
  return withSubdomainLock(() => {
    const id = normalizeSubdomainId(subdomain)
    if (!storage || !userPk || !appId || !id) return false
    const reverse = storage[`session_subdomainToApp_${id}$`]()
    if (storage[`session_subdomainByUserAndApp_${userPk}_${appId}$`]() !== id || reverse?.userPk !== userPk || reverse?.appId !== appId) return false
    return retireSubdomain(storage, id)
  })
}

export async function retireSubdomainsFor (storage, { userPk, appId } = {}) {
  return withSubdomainLock(() => {
    let count = 0
    const ids = new Set()
    for (const key of storage.keys()) {
      if (key.startsWith('session_subdomainToApp_')) {
        const mapping = storage[`${key}$`]()
        if ((!userPk || mapping?.userPk === userPk) && (!appId || mapping?.appId === appId)) ids.add(key.slice('session_subdomainToApp_'.length))
      } else if (key.startsWith('session_subdomainByUserAndApp_')) {
        const rest = key.slice('session_subdomainByUserAndApp_'.length)
        const separator = rest.indexOf('_')
        if ((!userPk || rest.slice(0, separator) === userPk) && (!appId || rest.slice(separator + 1) === appId)) {
          const id = storage[`${key}$`]()
          // Never retire an origin that now belongs to another pair.
          const reverse = storage[`session_subdomainToApp_${id}$`]()
          if (!reverse || (reverse.userPk === rest.slice(0, separator) && reverse.appId === rest.slice(separator + 1))) ids.add(id)
        }
      }
    }
    for (const id of ids) {
      if (!retireSubdomain(storage, id)) continue
      for (const key of storage.keys()) {
        if (key.startsWith('session_subdomainByUserAndApp_') && storage[`${key}$`]() === id) storage[`${key}$`](undefined)
      }
      count++
    }
    return count
  })
}
