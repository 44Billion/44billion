import { getDb } from '../index.js'

export const CHUNK_PAYLOADS_STORE = 'chunkPayloads'
export const CHUNK_COPIES_STORE = 'chunkCopies'
export const CHUNK_PAYLOAD_ROOTS_STORE = 'chunkPayloadRoots'
export const CHUNK_ROOTS_STORE = 'chunkRoots'
export const CHUNK_STATE_STORE = 'chunkState'
export const CHUNK_UNREFERENCED_QUOTA_BYTES = 2 * 1024 * 1024 * 1024
export const CHUNK_GRACE_MS = 10 * 60 * 1000

const ALL_STORES = [
  CHUNK_PAYLOADS_STORE,
  CHUNK_COPIES_STORE,
  CHUNK_PAYLOAD_ROOTS_STORE,
  CHUNK_ROOTS_STORE,
  CHUNK_STATE_STORE
]
const STATE_KEY = 'global'
const LOCK_NAME = '44billion:chunk-cache:v1'
const CHANNEL_NAME = '44billion:chunk-cache:v1'
const INSTANCE_ID = `${Date.now()}:${Math.random()}`
const RECONCILIATION_BATCH_SIZE = 256
const ROOT_TOUCH_INTERVAL_MS = 60 * 1000
const MAX_RECENT_ROOT_TOUCHES = 2048

let fallbackLock = Promise.resolve()
const localListeners = new Set()
const recentRootTouches = new Map()
let broadcastChannel

export class ChunkQuotaError extends Error {
  constructor () {
    super('Global unreferenced chunk quota exceeded')
    this.name = 'ChunkQuotaError'
    this.code = 'CHUNK_QUOTA_EXCEEDED'
  }
}

function requestResult (request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone (transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error || new Error('Chunk cache transaction aborted'))
    transaction.onerror = () => reject(transaction.error || new Error('Chunk cache transaction failed'))
  })
}

async function withStores (storeNames, mode, callback) {
  const db = await getDb()
  const transaction = db.transaction(storeNames, mode)
  const done = transactionDone(transaction)
  try {
    const result = await callback(transaction)
    await done
    return result
  } catch (error) {
    try { transaction.abort() } catch {}
    await done.catch(() => {})
    throw error
  }
}

export async function withChunkCacheLock (callback) {
  if (globalThis.navigator?.locks?.request) {
    return globalThis.navigator.locks.request(LOCK_NAME, callback)
  }

  const previous = fallbackLock
  let release
  fallbackLock = new Promise(resolve => { release = resolve })
  await previous
  try {
    return await callback()
  } finally {
    release()
  }
}

function initialState () {
  return {
    key: STATE_KEY,
    totalBytes: 0,
    unreferencedBytes: 0,
    payloadCount: 0,
    copyCount: 0,
    lastReconciledAt: 0
  }
}

function payloadContribution (payload) {
  return payload &&
    (payload.protectedRootCount || 0) === 0 &&
    (payload.pendingProtectedCount || 0) === 0
    ? payload.byteLength
    : 0
}

function snapshotPayload (payload) {
  return payload ? { ...payload } : null
}

async function loadPayload (store, cache, contentHash) {
  if (!cache.has(contentHash)) {
    cache.set(contentHash, await requestResult(store.get(contentHash)) || null)
  }
  return cache.get(contentHash)
}

async function flushPayloads (store, stateStore, state, payloads, originals) {
  for (const [contentHash, payload] of payloads) {
    const original = originals.get(contentHash) || null
    const shouldDelete = payload &&
      (payload.copyCount || 0) === 0 &&
      (payload.pendingCount || 0) === 0
    const finalPayload = shouldDelete ? null : payload

    state.unreferencedBytes += payloadContribution(finalPayload) - payloadContribution(original)
    if (!original && finalPayload) {
      state.totalBytes += finalPayload.byteLength
      state.payloadCount++
    } else if (original && !finalPayload) {
      state.totalBytes -= original.byteLength
      state.payloadCount--
    }

    if (finalPayload) {
      await requestResult(store.put(finalPayload))
    } else {
      await requestResult(store.delete(contentHash))
    }
  }
  state.totalBytes = Math.max(0, state.totalBytes)
  state.unreferencedBytes = Math.max(0, state.unreferencedBytes)
  state.payloadCount = Math.max(0, state.payloadCount)
  state.copyCount = Math.max(0, state.copyCount)
  await requestResult(stateStore.put(state))
}

export async function stageChunkPayload ({ contentHash, contentBytes, owner, protectedRoot = false }) {
  if (!/^[0-9a-f]{64}$/.test(contentHash || '')) throw new Error('Invalid chunk content hash')
  if (!(contentBytes instanceof Uint8Array)) throw new TypeError('Chunk payload should be a Uint8Array')
  if (owner !== undefined && !/^[0-9a-f]{64}$/.test(owner)) throw new Error('Invalid chunk owner')

  return withChunkCacheLock(() => withStores([
    CHUNK_PAYLOADS_STORE,
    CHUNK_STATE_STORE
  ], 'readwrite', async transaction => {
    const payloadStore = transaction.objectStore(CHUNK_PAYLOADS_STORE)
    const stateStore = transaction.objectStore(CHUNK_STATE_STORE)
    const state = await requestResult(stateStore.get(STATE_KEY)) || initialState()
    let payload = await requestResult(payloadStore.get(contentHash))

    if (payload && payload.byteLength !== contentBytes.byteLength) {
      throw new Error('Chunk content hash collision')
    }
    if (!payload && !protectedRoot && state.unreferencedBytes + contentBytes.byteLength > CHUNK_UNREFERENCED_QUOTA_BYTES) {
      throw new ChunkQuotaError()
    }

    const originalContribution = payloadContribution(payload)
    if (!payload) {
      payload = {
        contentHash,
        bytes: new Uint8Array(contentBytes),
        byteLength: contentBytes.byteLength,
        copyCount: 0,
        pendingCount: 0,
        protectedRootCount: 0,
        pendingProtectedCount: 0,
        lastAccessAt: Date.now()
      }
      state.totalBytes += payload.byteLength
      state.payloadCount++
    }
    payload.pendingCount = (payload.pendingCount || 0) + 1
    if (protectedRoot) payload.pendingProtectedCount = (payload.pendingProtectedCount || 0) + 1
    payload.pendingUpdatedAt = Date.now()
    payload.lastAccessAt = Date.now()
    state.unreferencedBytes += payloadContribution(payload) - originalContribution

    await requestResult(payloadStore.put(payload))
    await requestResult(stateStore.put(state))
    if (owner) await requestResult(stateStore.put({ key: `owner:${owner}`, owner }))
    return { contentHash, protectedRoot }
  }))
}

export async function abortChunkPayloadStage (stage) {
  if (!stage?.contentHash) return
  const { contentHash, protectedRoot = false } = stage
  return withChunkCacheLock(() => withStores([
    CHUNK_PAYLOADS_STORE,
    CHUNK_STATE_STORE
  ], 'readwrite', async transaction => {
    const payloadStore = transaction.objectStore(CHUNK_PAYLOADS_STORE)
    const stateStore = transaction.objectStore(CHUNK_STATE_STORE)
    const state = await requestResult(stateStore.get(STATE_KEY)) || initialState()
    const payload = await requestResult(payloadStore.get(contentHash))
    if (!payload) return

    const originals = new Map([[contentHash, snapshotPayload(payload)]])
    payload.pendingCount = Math.max(0, (payload.pendingCount || 0) - 1)
    if (protectedRoot) {
      payload.pendingProtectedCount = Math.max(0, (payload.pendingProtectedCount || 0) - 1)
    }
    if (payload.pendingCount === 0) delete payload.pendingUpdatedAt
    await flushPayloads(payloadStore, stateStore, state, new Map([[contentHash, payload]]), originals)
  }))
}

async function updateAssociation (associationStore, payloadStore, payloads, originals, {
  owner,
  root,
  contentHash,
  delta,
  referenced
}) {
  const key = [owner, root, contentHash]
  const association = await requestResult(associationStore.get(key))
  const payload = await loadPayload(payloadStore, payloads, contentHash)
  if (!payload && delta > 0) throw new Error('Missing staged chunk payload')
  if (payload && !originals.has(contentHash)) originals.set(contentHash, snapshotPayload(payload))

  if (delta > 0) {
    if (!association) {
      await requestResult(associationStore.put({ owner, root, contentHash, copyCount: delta }))
      if (referenced) payload.protectedRootCount = (payload.protectedRootCount || 0) + 1
    } else {
      association.copyCount += delta
      await requestResult(associationStore.put(association))
    }
  } else if (association) {
    association.copyCount += delta
    if (association.copyCount <= 0) {
      await requestResult(associationStore.delete(key))
      if (referenced && payload) {
        payload.protectedRootCount = Math.max(0, (payload.protectedRootCount || 0) - 1)
      }
    } else {
      await requestResult(associationStore.put(association))
    }
  }
}

export async function commitChunkCopy ({
  owner,
  root,
  index,
  total,
  eventId,
  contentHash,
  byteLength,
  protectedRoot = false
}) {
  const notification = await withChunkCacheLock(() => withStores(ALL_STORES, 'readwrite', async transaction => {
    const payloadStore = transaction.objectStore(CHUNK_PAYLOADS_STORE)
    const copyStore = transaction.objectStore(CHUNK_COPIES_STORE)
    const associationStore = transaction.objectStore(CHUNK_PAYLOAD_ROOTS_STORE)
    const rootStore = transaction.objectStore(CHUNK_ROOTS_STORE)
    const stateStore = transaction.objectStore(CHUNK_STATE_STORE)
    const state = await requestResult(stateStore.get(STATE_KEY)) || initialState()
    const payloads = new Map()
    const originals = new Map()
    const payload = await loadPayload(payloadStore, payloads, contentHash)
    if (!payload || payload.byteLength !== byteLength) throw new Error('Missing staged chunk payload')
    originals.set(contentHash, snapshotPayload(payload))

    payload.pendingCount = Math.max(0, (payload.pendingCount || 0) - 1)
    if (protectedRoot) {
      payload.pendingProtectedCount = Math.max(0, (payload.pendingProtectedCount || 0) - 1)
    }
    if (payload.pendingCount === 0) delete payload.pendingUpdatedAt

    const key = [owner, root, index]
    const existing = await requestResult(copyStore.get(key))
    const existingRootIndexCount = await requestResult(
      copyStore.index('byRootIndex').count([root, index])
    )
    let rootRecord = await requestResult(rootStore.get([owner, root]))
    const wasReferenced = !!rootRecord?.referenced
    if (!rootRecord) {
      rootRecord = {
        owner,
        root,
        total,
        chunkCount: 0,
        referenceCount: 0,
        referenced: 0,
        lastActivityAt: Date.now()
      }
    }
    if (protectedRoot && !rootRecord.referenced) {
      rootRecord.referenced = 1
      rootRecord.referenceCount = Math.max(1, rootRecord.referenceCount || 0)
    }
    const referenced = !!rootRecord.referenced

    if (existing) {
      const oldPayload = await loadPayload(payloadStore, payloads, existing.contentHash)
      if (oldPayload) {
        if (!originals.has(existing.contentHash)) originals.set(existing.contentHash, snapshotPayload(oldPayload))
        oldPayload.copyCount = Math.max(0, (oldPayload.copyCount || 0) - 1)
      }
      await updateAssociation(associationStore, payloadStore, payloads, originals, {
        owner,
        root,
        contentHash: existing.contentHash,
        delta: -1,
        referenced: wasReferenced
      })
    } else {
      rootRecord.chunkCount++
      state.copyCount++
    }

    payload.copyCount = (payload.copyCount || 0) + 1
    await updateAssociation(associationStore, payloadStore, payloads, originals, {
      owner,
      root,
      contentHash,
      delta: 1,
      referenced
    })

    rootRecord.total = total
    rootRecord.lastActivityAt = Date.now()
    await requestResult(rootStore.put(rootRecord))
    await requestResult(copyStore.put({
      owner,
      root,
      index,
      total,
      eventId,
      contentHash,
      byteLength
    }))
    await flushPayloads(payloadStore, stateStore, state, payloads, originals)
    return {
      root,
      index,
      owner,
      isNew: !existing,
      newRootIndex: existingRootIndexCount === 0
    }
  }))

  if (notification.isNew) notifyChunkArrival(notification)
  return notification
}

export async function setOwnerRootReferenceCount (owner, root, referenceCount) {
  const count = Math.max(0, Number.isSafeInteger(referenceCount) ? referenceCount : 0)
  return withChunkCacheLock(() => withStores([
    CHUNK_PAYLOADS_STORE,
    CHUNK_PAYLOAD_ROOTS_STORE,
    CHUNK_ROOTS_STORE,
    CHUNK_STATE_STORE
  ], 'readwrite', async transaction => {
    const payloadStore = transaction.objectStore(CHUNK_PAYLOADS_STORE)
    const associationStore = transaction.objectStore(CHUNK_PAYLOAD_ROOTS_STORE)
    const rootStore = transaction.objectStore(CHUNK_ROOTS_STORE)
    const stateStore = transaction.objectStore(CHUNK_STATE_STORE)
    const state = await requestResult(stateStore.get(STATE_KEY)) || initialState()
    let rootRecord = await requestResult(rootStore.get([owner, root]))
    if (!rootRecord && count === 0) return
    rootRecord ||= {
      owner,
      root,
      total: null,
      chunkCount: 0,
      lastActivityAt: Date.now()
    }
    const wasReferenced = !!rootRecord.referenced
    const referenced = count > 0
    rootRecord.referenceCount = count
    rootRecord.referenced = referenced ? 1 : 0
    if (wasReferenced === referenced) {
      await requestResult(rootStore.put(rootRecord))
      return
    }

    const associations = await requestResult(
      associationStore.index('byOwnerRoot').getAll([owner, root])
    )
    const payloads = new Map()
    const originals = new Map()
    for (const association of associations) {
      const payload = await loadPayload(payloadStore, payloads, association.contentHash)
      if (!payload) continue
      originals.set(association.contentHash, snapshotPayload(payload))
      payload.protectedRootCount = Math.max(0, (payload.protectedRootCount || 0) + (referenced ? 1 : -1))
    }
    await requestResult(rootStore.put(rootRecord))
    await flushPayloads(payloadStore, stateStore, state, payloads, originals)
  }))
}

export async function getChunkPayload (contentHash, { touch = true } = {}) {
  const payload = await withStores([CHUNK_PAYLOADS_STORE], 'readonly', transaction =>
    requestResult(transaction.objectStore(CHUNK_PAYLOADS_STORE).get(contentHash))
  )
  if (!payload) return null
  if (touch) touchPayload(contentHash).catch(() => {})
  return new Uint8Array(payload.bytes)
}

export async function getChunkPayloadForEvent (owner, eventId, { touch = true } = {}) {
  const result = await withStores([
    CHUNK_COPIES_STORE,
    CHUNK_PAYLOADS_STORE
  ], 'readonly', async transaction => {
    const copy = await requestResult(
      transaction.objectStore(CHUNK_COPIES_STORE).index('byOwnerEvent').get([owner, eventId])
    )
    if (!copy) return null
    const payload = await requestResult(
      transaction.objectStore(CHUNK_PAYLOADS_STORE).get(copy.contentHash)
    )
    return payload ? { copy, contentBytes: new Uint8Array(payload.bytes) } : null
  })
  if (touch && result) {
    await touchOwnerRootIfNeeded(owner, result.copy.root, result.copy.contentHash).catch(() => {})
  }
  return result
}

export async function findLocalChunk (root, index, { preferredOwner } = {}) {
  const result = await withStores([
    CHUNK_COPIES_STORE,
    CHUNK_PAYLOADS_STORE
  ], 'readonly', async transaction => {
    const copies = await requestResult(
      transaction.objectStore(CHUNK_COPIES_STORE).index('byRootIndex').getAll([root, index])
    )
    copies.sort((a, b) => {
      const aPreferred = a.owner === preferredOwner ? 0 : 1
      const bPreferred = b.owner === preferredOwner ? 0 : 1
      return aPreferred - bPreferred || a.owner.localeCompare(b.owner) || a.eventId.localeCompare(b.eventId)
    })
    for (const copy of copies) {
      const payload = await requestResult(
        transaction.objectStore(CHUNK_PAYLOADS_STORE).get(copy.contentHash)
      )
      if (payload) return { ...copy, contentBytes: new Uint8Array(payload.bytes) }
    }
    return null
  })
  if (result) await touchOwnerRootIfNeeded(result.owner, root, result.contentHash).catch(() => {})
  return result
}

export async function findAnyLocalChunk (root, { preferredOwner } = {}) {
  const result = await withStores([
    CHUNK_ROOTS_STORE,
    CHUNK_COPIES_STORE,
    CHUNK_PAYLOADS_STORE
  ], 'readonly', async transaction => {
    const copyStore = transaction.objectStore(CHUNK_COPIES_STORE)
    let copies = []
    if (preferredOwner) {
      const preferredRoot = await requestResult(
        transaction.objectStore(CHUNK_ROOTS_STORE).get([preferredOwner, root])
      )
      if (preferredRoot) {
        copies = await requestResult(copyStore.index('byOwnerRoot').getAll([preferredOwner, root], 64))
        copies.sort((a, b) => a.index - b.index || a.eventId.localeCompare(b.eventId))
      }
    }
    if (copies.length === 0) {
      copies = await requestResult(copyStore.index('byRootIndex').getAll(
        IDBKeyRange.bound([root, 0], [root, Number.MAX_SAFE_INTEGER]),
        64
      ))
    }
    for (const copy of copies) {
      const payload = await requestResult(
        transaction.objectStore(CHUNK_PAYLOADS_STORE).get(copy.contentHash)
      )
      if (payload) return { ...copy, contentBytes: new Uint8Array(payload.bytes) }
    }
    return null
  })
  if (result) await touchOwnerRootIfNeeded(result.owner, root, result.contentHash).catch(() => {})
  return result
}

export async function getOwnerChunkCopy (owner, root, index) {
  return withStores([CHUNK_COPIES_STORE], 'readonly', transaction =>
    requestResult(transaction.objectStore(CHUNK_COPIES_STORE).get([owner, root, index]))
  )
}

export async function getOwnerChunkRoot (owner, root) {
  return withStores([CHUNK_ROOTS_STORE], 'readonly', transaction =>
    requestResult(transaction.objectStore(CHUNK_ROOTS_STORE).get([owner, root]))
  )
}

async function touchPayload (contentHash) {
  return withStores([CHUNK_PAYLOADS_STORE], 'readwrite', async transaction => {
    const store = transaction.objectStore(CHUNK_PAYLOADS_STORE)
    const payload = await requestResult(store.get(contentHash))
    if (!payload) return
    payload.lastAccessAt = Date.now()
    await requestResult(store.put(payload))
  })
}

async function touchOwnerRoot (owner, root, contentHash) {
  return withStores([CHUNK_ROOTS_STORE, CHUNK_PAYLOADS_STORE], 'readwrite', async transaction => {
    const rootStore = transaction.objectStore(CHUNK_ROOTS_STORE)
    const rootRecord = await requestResult(rootStore.get([owner, root]))
    if (rootRecord) {
      rootRecord.lastActivityAt = Date.now()
      await requestResult(rootStore.put(rootRecord))
    }
    const payloadStore = transaction.objectStore(CHUNK_PAYLOADS_STORE)
    const payload = await requestResult(payloadStore.get(contentHash))
    if (payload) {
      payload.lastAccessAt = Date.now()
      await requestResult(payloadStore.put(payload))
    }
  })
}

async function touchOwnerRootIfNeeded (owner, root, contentHash) {
  const key = `${owner}:${root}`
  const now = Date.now()
  if (now - (recentRootTouches.get(key) || 0) < ROOT_TOUCH_INTERVAL_MS) return
  if (!recentRootTouches.has(key) && recentRootTouches.size >= MAX_RECENT_ROOT_TOUCHES) {
    for (const [candidate, touchedAt] of recentRootTouches) {
      if (now - touchedAt >= ROOT_TOUCH_INTERVAL_MS) recentRootTouches.delete(candidate)
    }
    while (recentRootTouches.size >= MAX_RECENT_ROOT_TOUCHES) {
      recentRootTouches.delete(recentRootTouches.keys().next().value)
    }
  }
  recentRootTouches.set(key, now)
  try {
    await touchOwnerRoot(owner, root, contentHash)
  } catch (error) {
    if (recentRootTouches.get(key) === now) recentRootTouches.delete(key)
    throw error
  }
}

export async function listChunkRootPurgeCandidates ({ before = Infinity, limit = 100 } = {}) {
  return withStores([CHUNK_ROOTS_STORE], 'readonly', transaction => new Promise((resolve, reject) => {
    const results = []
    const store = transaction.objectStore(CHUNK_ROOTS_STORE).index('byPurge')
    const upper = Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER
    const request = store.openCursor(IDBKeyRange.bound([0, 0], [0, upper]))
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor || results.length >= limit) {
        resolve(results)
        return
      }
      results.push(cursor.value)
      cursor.continue()
    }
  }))
}

async function removeOwnerRootCopyBatch (owner, root, limit) {
  return withStores(ALL_STORES, 'readwrite', async transaction => {
    const payloadStore = transaction.objectStore(CHUNK_PAYLOADS_STORE)
    const copyStore = transaction.objectStore(CHUNK_COPIES_STORE)
    const associationStore = transaction.objectStore(CHUNK_PAYLOAD_ROOTS_STORE)
    const rootStore = transaction.objectStore(CHUNK_ROOTS_STORE)
    const stateStore = transaction.objectStore(CHUNK_STATE_STORE)
    const state = await requestResult(stateStore.get(STATE_KEY)) || initialState()
    const rootRecord = await requestResult(rootStore.get([owner, root]))
    const referenced = !!rootRecord?.referenced
    const copies = await requestResult(copyStore.index('byOwnerRoot').getAll([owner, root], limit))
    const payloads = new Map()
    const originals = new Map()

    for (const copy of copies) {
      const payload = await loadPayload(payloadStore, payloads, copy.contentHash)
      if (payload) {
        if (!originals.has(copy.contentHash)) originals.set(copy.contentHash, snapshotPayload(payload))
        payload.copyCount = Math.max(0, (payload.copyCount || 0) - 1)
      }
      await updateAssociation(associationStore, payloadStore, payloads, originals, {
        owner,
        root,
        contentHash: copy.contentHash,
        delta: -1,
        referenced
      })
      await requestResult(copyStore.delete([owner, root, copy.index]))
      state.copyCount--
    }
    if (rootRecord) {
      rootRecord.chunkCount = Math.max(0, (rootRecord.chunkCount || 0) - copies.length)
      await requestResult(rootStore.put(rootRecord))
    }
    await flushPayloads(payloadStore, stateStore, state, payloads, originals)
    return copies.length
  })
}

async function removeOwnerRootAssociationBatch (owner, root, limit) {
  return withStores([
    CHUNK_PAYLOADS_STORE,
    CHUNK_PAYLOAD_ROOTS_STORE,
    CHUNK_ROOTS_STORE,
    CHUNK_STATE_STORE
  ], 'readwrite', async transaction => {
    const payloadStore = transaction.objectStore(CHUNK_PAYLOADS_STORE)
    const associationStore = transaction.objectStore(CHUNK_PAYLOAD_ROOTS_STORE)
    const rootStore = transaction.objectStore(CHUNK_ROOTS_STORE)
    const stateStore = transaction.objectStore(CHUNK_STATE_STORE)
    const state = await requestResult(stateStore.get(STATE_KEY)) || initialState()
    const rootRecord = await requestResult(rootStore.get([owner, root]))
    const referenced = !!rootRecord?.referenced
    const associations = await requestResult(
      associationStore.index('byOwnerRoot').getAll([owner, root], limit)
    )
    const payloads = new Map()
    const originals = new Map()
    for (const association of associations) {
      const payload = await loadPayload(payloadStore, payloads, association.contentHash)
      if (payload && referenced) {
        originals.set(association.contentHash, snapshotPayload(payload))
        payload.protectedRootCount = Math.max(0, (payload.protectedRootCount || 0) - 1)
      }
      await requestResult(associationStore.delete([owner, root, association.contentHash]))
    }
    await flushPayloads(payloadStore, stateStore, state, payloads, originals)
    return associations.length
  })
}

export async function removeOwnerRootCopies (owner, root) {
  return withChunkCacheLock(async () => {
    let removed = 0
    while (true) {
      const count = await removeOwnerRootCopyBatch(owner, root, RECONCILIATION_BATCH_SIZE)
      removed += count
      if (count < RECONCILIATION_BATCH_SIZE) break
    }
    while (true) {
      const count = await removeOwnerRootAssociationBatch(owner, root, RECONCILIATION_BATCH_SIZE)
      if (count === 0) break
    }
    await withStores([CHUNK_ROOTS_STORE], 'readwrite', transaction =>
      requestResult(transaction.objectStore(CHUNK_ROOTS_STORE).delete([owner, root]))
    )
    return removed
  })
}

export async function removeChunkCopy (owner, root, index, { eventId } = {}) {
  return withChunkCacheLock(() => withStores(ALL_STORES, 'readwrite', async transaction => {
    const payloadStore = transaction.objectStore(CHUNK_PAYLOADS_STORE)
    const copyStore = transaction.objectStore(CHUNK_COPIES_STORE)
    const associationStore = transaction.objectStore(CHUNK_PAYLOAD_ROOTS_STORE)
    const rootStore = transaction.objectStore(CHUNK_ROOTS_STORE)
    const stateStore = transaction.objectStore(CHUNK_STATE_STORE)
    const copy = await requestResult(copyStore.get([owner, root, index]))
    if (!copy) return false
    if (eventId !== undefined && copy.eventId !== eventId) return false
    const state = await requestResult(stateStore.get(STATE_KEY)) || initialState()
    const rootRecord = await requestResult(rootStore.get([owner, root]))
    const payload = await requestResult(payloadStore.get(copy.contentHash))
    const payloads = new Map()
    const originals = new Map()
    if (payload) {
      originals.set(copy.contentHash, snapshotPayload(payload))
      payload.copyCount = Math.max(0, (payload.copyCount || 0) - 1)
      payloads.set(copy.contentHash, payload)
    }
    await updateAssociation(associationStore, payloadStore, payloads, originals, {
      owner,
      root,
      contentHash: copy.contentHash,
      delta: -1,
      referenced: !!rootRecord?.referenced
    })
    await requestResult(copyStore.delete([owner, root, index]))
    state.copyCount--
    if (rootRecord) {
      rootRecord.chunkCount = Math.max(0, (rootRecord.chunkCount || 0) - 1)
      if (rootRecord.chunkCount === 0 && !rootRecord.referenced) {
        await requestResult(rootStore.delete([owner, root]))
      } else {
        await requestResult(rootStore.put(rootRecord))
      }
    }
    await flushPayloads(payloadStore, stateStore, state, payloads, originals)
    return true
  }))
}

export async function listOwnerChunkCopiesPage (owner, { after, limit = 256 } = {}) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit should be a positive safe integer')
  const lower = after
    ? [owner, after.root, after.index]
    : [owner, '', 0]
  const upper = [owner, '\uffff', Number.MAX_SAFE_INTEGER]
  return withStores([CHUNK_COPIES_STORE], 'readonly', transaction =>
    requestResult(transaction.objectStore(CHUNK_COPIES_STORE).getAll(
      IDBKeyRange.bound(lower, upper, !!after, false),
      limit
    ))
  )
}

export async function listOwnerChunkRootsPage (owner, { after, limit = 256 } = {}) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit should be a positive safe integer')
  const lower = after ? [owner, after] : [owner, '']
  const upper = [owner, '\uffff']
  return withStores([CHUNK_ROOTS_STORE], 'readonly', transaction =>
    requestResult(transaction.objectStore(CHUNK_ROOTS_STORE).getAll(
      IDBKeyRange.bound(lower, upper, !!after, false),
      limit
    ))
  )
}

export async function listChunkCacheOwners () {
  return withStores([CHUNK_ROOTS_STORE, CHUNK_STATE_STORE], 'readonly', async transaction => {
    const owners = new Set((await requestResult(
      transaction.objectStore(CHUNK_STATE_STORE).getAll(
        IDBKeyRange.bound('owner:', 'owner:\uffff')
      )
    )).map(record => record.owner).filter(owner => typeof owner === 'string'))
    await new Promise((resolve, reject) => {
      const request = transaction.objectStore(CHUNK_ROOTS_STORE).openKeyCursor()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve()
          return
        }
        const owner = cursor.primaryKey?.[0]
        if (typeof owner !== 'string') {
          cursor.continue()
          return
        }
        owners.add(owner)
        cursor.continue([owner, '\uffff'])
      }
    })
    return [...owners].sort()
  })
}

export async function reconcileStaleChunkPayloadStages ({
  before = Date.now() - CHUNK_GRACE_MS,
  limit = RECONCILIATION_BATCH_SIZE,
  restart = false
} = {}) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit should be a positive safe integer')
  return withChunkCacheLock(() => withStores([
    CHUNK_PAYLOADS_STORE,
    CHUNK_STATE_STORE
  ], 'readwrite', async transaction => {
    const payloadStore = transaction.objectStore(CHUNK_PAYLOADS_STORE)
    const stateStore = transaction.objectStore(CHUNK_STATE_STORE)
    const state = await requestResult(stateStore.get(STATE_KEY)) || initialState()
    const after = !restart && typeof state.payloadReconcileAfter === 'string'
      ? state.payloadReconcileAfter
      : null
    const range = after ? IDBKeyRange.lowerBound(after, true) : null
    const payloads = new Map()
    const originals = new Map()
    let lastKey = null
    let reachedEnd = false

    await new Promise((resolve, reject) => {
      let visited = 0
      const request = payloadStore.openCursor(range)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          reachedEnd = true
          resolve()
          return
        }
        const payload = cursor.value
        lastKey = cursor.primaryKey
        visited++
        if (
          (payload.pendingCount || 0) > 0 &&
          (payload.pendingUpdatedAt || 0) <= before
        ) {
          originals.set(payload.contentHash, snapshotPayload(payload))
          payload.pendingCount = 0
          payload.pendingProtectedCount = 0
          delete payload.pendingUpdatedAt
          payloads.set(payload.contentHash, payload)
        }
        if (visited >= limit) {
          resolve()
          return
        }
        cursor.continue()
      }
    })

    state.payloadReconcileAfter = reachedEnd ? null : lastKey
    if (payloads.size > 0) {
      await flushPayloads(payloadStore, stateStore, state, payloads, originals)
    } else {
      await requestResult(stateStore.put(state))
    }
    return { cleaned: payloads.size, reachedEnd }
  }))
}

export async function clearOwnerChunkCache (owner) {
  while (true) {
    const roots = await listOwnerChunkRootsPage(owner, { limit: RECONCILIATION_BATCH_SIZE })
    if (roots.length === 0) break
    for (const { root } of roots) await removeOwnerRootCopies(owner, root)
  }

  // Recover from an otherwise impossible copy-without-root inconsistency.
  while (true) {
    const copies = await listOwnerChunkCopiesPage(owner, { limit: RECONCILIATION_BATCH_SIZE })
    if (copies.length === 0) break
    for (const root of new Set(copies.map(copy => copy.root))) {
      await removeOwnerRootCopies(owner, root)
    }
  }

  await withChunkCacheLock(() => withStores([
    CHUNK_STATE_STORE
  ], 'readwrite', async transaction => {
    await requestResult(transaction.objectStore(CHUNK_STATE_STORE).delete(`owner:${owner}`))
  }))
  for (const key of recentRootTouches.keys()) {
    if (key.startsWith(`${owner}:`)) recentRootTouches.delete(key)
  }
}

export async function getChunkState () {
  return withStores([CHUNK_STATE_STORE], 'readonly', async transaction =>
    await requestResult(transaction.objectStore(CHUNK_STATE_STORE).get(STATE_KEY)) || initialState()
  )
}

export async function markChunkReconciled () {
  return withStores([CHUNK_STATE_STORE], 'readwrite', async transaction => {
    const store = transaction.objectStore(CHUNK_STATE_STORE)
    const state = await requestResult(store.get(STATE_KEY)) || initialState()
    state.lastReconciledAt = Date.now()
    await requestResult(store.put(state))
  })
}

function notifyChunkArrival (notification) {
  for (const listener of localListeners) listener(notification)
  if (typeof BroadcastChannel === 'function') {
    broadcastChannel ??= new BroadcastChannel(CHANNEL_NAME)
    broadcastChannel.unref?.()
    broadcastChannel.postMessage({ ...notification, source: INSTANCE_ID })
  }
}

export function subscribeChunkArrivals (root, callback) {
  const listener = notification => {
    if (notification?.root === root) callback(notification)
  }
  localListeners.add(listener)
  let channel
  if (typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.unref?.()
    channel.onmessage = ({ data }) => {
      if (data?.source !== INSTANCE_ID) listener(data)
    }
  }
  return () => {
    localListeners.delete(listener)
    channel?.close()
  }
}
