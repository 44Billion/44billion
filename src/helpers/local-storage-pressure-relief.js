const APP_METADATA_PRIORITY = Object.freeze([
  '_icon',
  '_description',
  '_relayHints',
  '_name'
])
const APP_METADATA_PREFIX = 'session_appById_'
const MAX_KEYS_PER_ROUND = 10
const MAX_BYTES_PER_ROUND = 64 * 1024
const MAX_ROUNDS = 3
const encoder = new TextEncoder()
let installed = null

function isQuotaExceeded (error) {
  return error?.name === 'QuotaExceededError' ||
    error?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    error?.code === 22 ||
    error?.code === 1014 ||
    /quota/i.test(error?.message || '')
}

function appMetadataRank (key) {
  if (!key.startsWith(APP_METADATA_PREFIX)) return -1
  return APP_METADATA_PRIORITY.findIndex(suffix => key.endsWith(suffix))
}

export function localStorageReliefCandidates (storage = globalThis.localStorage) {
  const candidates = []
  for (let index = 0; index < (storage?.length || 0); index++) {
    const key = storage.key(index)
    const rank = appMetadataRank(key)
    if (rank < 0) continue
    const value = storage.getItem(key) || ''
    candidates.push({ key, rank, bytes: encoder.encode(value).byteLength })
  }
  return candidates.sort((left, right) =>
    left.rank - right.rank ||
    right.bytes - left.bytes ||
    left.key.localeCompare(right.key))
}

function dispatchRemovalEvent ({ key, oldValue, storage, StorageEventClass, location, eventTarget }) {
  if (typeof StorageEventClass !== 'function') return
  try {
    eventTarget.dispatchEvent?.(new StorageEventClass('storage', {
      key,
      oldValue,
      newValue: null,
      storageArea: storage,
      url: location?.href || ''
    }))
  } catch {}
}

function evictOneRound ({
  storage,
  originalRemoveItem,
  StorageEventClass,
  location,
  eventTarget
}) {
  let removed = 0
  let bytes = 0
  for (const candidate of localStorageReliefCandidates(storage)) {
    if (removed >= MAX_KEYS_PER_ROUND) break
    // Values cannot be split. Allow one oversized value when it is the only
    // way to make progress, but otherwise keep each round within the budget.
    if (removed > 0 && bytes + candidate.bytes > MAX_BYTES_PER_ROUND) break
    const oldValue = storage.getItem(candidate.key)
    if (oldValue == null) continue
    originalRemoveItem.call(storage, candidate.key)
    dispatchRemovalEvent({
      key: candidate.key,
      oldValue,
      storage,
      StorageEventClass,
      location,
      eventTarget
    })
    removed++
    bytes += candidate.bytes
  }
  return { removed, bytes }
}

export function installLocalStoragePressureRelief ({
  storage = globalThis.localStorage,
  prototype = globalThis.Storage?.prototype,
  StorageEventClass = globalThis.StorageEvent,
  location = globalThis.location,
  eventTarget = globalThis
} = {}) {
  if (installed?.storage === storage && installed.prototype === prototype) return installed.uninstall
  if (!storage || !prototype?.setItem || !prototype?.removeItem) return () => {}

  const originalSetItem = prototype.setItem
  const originalRemoveItem = prototype.removeItem
  function pressureRelievingSetItem (key, value) {
    let lastError
    for (let round = 0; round < MAX_ROUNDS; round++) {
      try {
        return originalSetItem.call(this, key, value)
      } catch (error) {
        if (this !== storage || !isQuotaExceeded(error)) throw error
        lastError = error
        let evicted
        try {
          evicted = evictOneRound({
            storage,
            originalRemoveItem,
            StorageEventClass,
            location,
            eventTarget
          })
        } catch {
          throw error
        }
        if (!evicted.removed) throw error
      }
    }
    try {
      return originalSetItem.call(this, key, value)
    } catch (error) {
      throw lastError || error
    }
  }

  prototype.setItem = pressureRelievingSetItem
  const uninstall = () => {
    if (prototype.setItem === pressureRelievingSetItem) prototype.setItem = originalSetItem
    if (installed?.uninstall === uninstall) installed = null
  }
  installed = { storage, prototype, uninstall }
  return uninstall
}

export function uninstallLocalStoragePressureRelief () {
  installed?.uninstall?.()
}
