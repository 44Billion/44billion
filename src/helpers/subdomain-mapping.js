const SUBDOMAIN_FREE_IDS_KEY = 'session_subdomainFreeIds'

function normalizeSubdomainId (value) {
  const id = String(value ?? '')
  if (!/^\d+$/.test(id)) return ''
  const number = Number(id)
  if (!Number.isSafeInteger(number) || number < 0) return ''
  return String(number)
}

export function normalizeSubdomainFreeIds (value) {
  if (!Array.isArray(value)) return []
  const ids = new Set()
  for (const item of value) {
    const id = normalizeSubdomainId(item)
    if (id) ids.add(id)
  }
  return Array.from(ids).sort((a, b) => Number(a) - Number(b))
}

export function addSubdomainFreeId (freeIds, subdomain) {
  const id = normalizeSubdomainId(subdomain)
  if (!id) return normalizeSubdomainFreeIds(freeIds)
  return normalizeSubdomainFreeIds([...(Array.isArray(freeIds) ? freeIds : []), id])
}

export function allocateAppSubdomain (storage, { userPk, appId }) {
  if (!storage || !userPk || !appId) return ''

  const freeIds = normalizeSubdomainFreeIds(storage[`${SUBDOMAIN_FREE_IDS_KEY}$`]())
  let subdomain = ''

  while (freeIds.length > 0) {
    const candidate = freeIds.shift()
    if (storage[`session_subdomainToApp_${candidate}$`]() == null) {
      subdomain = candidate
      break
    }
  }

  if (!subdomain) {
    const nextId = Number(storage.session_subdomainNextId$() ?? 0)
    subdomain = String(Number.isSafeInteger(nextId) && nextId >= 0 ? nextId : 0)
    storage.session_subdomainNextId$(Number(subdomain) + 1)
  }

  storage[`${SUBDOMAIN_FREE_IDS_KEY}$`](freeIds.length ? freeIds : undefined)
  storage[`session_subdomainByUserAndApp_${userPk}_${appId}$`](subdomain)
  storage[`session_subdomainToApp_${subdomain}$`]({ appId, userPk })
  return subdomain
}

export function releaseAppSubdomain (storage, { userPk, appId, subdomain }) {
  const id = normalizeSubdomainId(subdomain)
  if (!storage || !userPk || !appId || !id) return false

  storage[`session_subdomainByUserAndApp_${userPk}_${appId}$`](undefined)
  storage[`session_subdomainToApp_${id}$`](undefined)

  const freeIds = addSubdomainFreeId(storage[`${SUBDOMAIN_FREE_IDS_KEY}$`](), id)
  storage[`${SUBDOMAIN_FREE_IDS_KEY}$`](freeIds.length ? freeIds : undefined)
  return true
}
