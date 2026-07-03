import { APP_FILE_CHUNK_BYTES } from '#constants/app-file.js'

const STORAGE_KEY = '44billion:app-asset-budget:v1'
const THREE_GB = 3 * 1024 * 1024 * 1024

export const ASSET_BUDGET_STEP_BYTES = THREE_GB
export const ASSET_BUDGET_BACKGROUND_DENIED = 'ASSET_BUDGET_BACKGROUND_DENIED'
export const ASSET_BUDGET_DENIED_BY_USER = 'ASSET_BUDGET_DENIED_BY_USER'

function getLocalStorage (storage) {
  return storage ?? globalThis.localStorage
}

function safeJsonParse (value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch (_err) {
    return fallback
  }
}

function normalizePositiveInteger (value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function normalizeAppId (appId) {
  if (typeof appId !== 'string' || appId.length === 0) throw new Error('Missing app id')
  return appId
}

function roundUpToStep (bytes, stepBytes = ASSET_BUDGET_STEP_BYTES) {
  if (bytes <= stepBytes) return stepBytes
  return Math.ceil(bytes / stepBytes) * stepBytes
}

function createBudgetError (message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

export function formatAssetBudgetBytes (bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB'
  const gb = bytes / (1024 * 1024 * 1024)
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`
}

export function normalizeAssetBudgetState (state) {
  const cachedBytes = normalizePositiveInteger(state?.cachedBytes)
  return {
    cachedBytes,
    approvedBytes: normalizePositiveInteger(state?.approvedBytes, ASSET_BUDGET_STEP_BYTES),
    rebuiltAt: normalizePositiveInteger(state?.rebuiltAt)
  }
}

function normalizeAssetBudgetStore (state) {
  const appById = {}
  for (const [appId, appState] of Object.entries(state?.appById ?? {})) {
    if (typeof appId !== 'string' || appId.length === 0) continue
    appById[appId] = normalizeAssetBudgetState(appState)
  }
  return { appById }
}

function readAssetBudgetStore ({ _localStorage } = {}) {
  return normalizeAssetBudgetStore(
    safeJsonParse(getLocalStorage(_localStorage)?.getItem(STORAGE_KEY), null)
  )
}

function writeAssetBudgetStore (store, { _localStorage } = {}) {
  const storage = getLocalStorage(_localStorage)
  const next = normalizeAssetBudgetStore(store)
  storage?.setItem(STORAGE_KEY, JSON.stringify(next))
  return next
}

export function readAssetBudgetState ({ appId, _localStorage } = {}) {
  appId = normalizeAppId(appId)
  return readAssetBudgetStore({ _localStorage }).appById[appId] ?? normalizeAssetBudgetState(null)
}

export function writeAssetBudgetState (state, { appId, _localStorage } = {}) {
  appId = normalizeAppId(appId)
  const store = readAssetBudgetStore({ _localStorage })
  store.appById[appId] = normalizeAssetBudgetState(state)
  return writeAssetBudgetStore(store, { _localStorage }).appById[appId]
}

export function applyAssetBudgetDelta (deltaBytes, deps = {}) {
  if (!Number.isFinite(deltaBytes) || deltaBytes === 0) return readAssetBudgetState(deps)
  const current = readAssetBudgetState(deps)
  return writeAssetBudgetState({
    ...current,
    cachedBytes: Math.max(0, current.cachedBytes + Math.trunc(deltaBytes))
  }, deps)
}

export async function rebuildAssetBudgetFromChunks ({
  appId,
  _countFileChunksForApp,
  _streamFileChunksForApp,
  _now = Date.now,
  ...deps
} = {}) {
  appId = normalizeAppId(appId)
  let chunkCount
  if (typeof _countFileChunksForApp === 'function') {
    chunkCount = await _countFileChunksForApp(appId)
  } else {
    if (typeof _streamFileChunksForApp !== 'function') throw new Error('Missing app file chunk counter')
    chunkCount = 0
    for await (const _ of _streamFileChunksForApp(appId)) chunkCount++
  }
  const cachedBytes = normalizePositiveInteger(chunkCount) * APP_FILE_CHUNK_BYTES
  return writeAssetBudgetState({
    cachedBytes,
    approvedBytes: roundUpToStep(cachedBytes),
    rebuiltAt: _now()
  }, { appId, ...deps })
}

export async function ensureAssetBudgetInitialized ({
  appId,
  _countFileChunksForApp,
  _streamFileChunksForApp,
  ...deps
} = {}) {
  appId = normalizeAppId(appId)
  const current = readAssetBudgetState({ appId, ...deps })
  if (!getLocalStorage(deps._localStorage)) return current
  if (current.rebuiltAt > 0) return current
  return rebuildAssetBudgetFromChunks({ appId, _countFileChunksForApp, _streamFileChunksForApp, ...deps })
}

function replacementProjectedBytes ({ cachedBytes, deltaBytes, replacement }) {
  const projected = cachedBytes + deltaBytes
  if (!replacement) return projected

  const oldBytes = normalizePositiveInteger(replacement.oldBytes)
  const newBytes = normalizePositiveInteger(replacement.newBytes)
  const nextNewBytes = newBytes + Math.max(0, deltaBytes)
  return Math.max(0, cachedBytes - oldBytes - newBytes + Math.max(oldBytes, nextNewBytes))
}

export async function ensureCanStoreAppAssetBytes (deltaBytes, {
  mode = 'foreground',
  appId,
  filename,
  replacement,
  requestConfirmation,
  ...deps
} = {}) {
  deltaBytes = Math.trunc(deltaBytes)
  appId = normalizeAppId(appId)
  if (!Number.isFinite(deltaBytes) || deltaBytes <= 0) return readAssetBudgetState({ appId, ...deps })

  const current = readAssetBudgetState({ appId, ...deps })
  const projectedBytes = replacementProjectedBytes({
    cachedBytes: current.cachedBytes,
    deltaBytes,
    replacement
  })
  if (projectedBytes <= current.approvedBytes) return current

  const nextApprovedBytes = roundUpToStep(projectedBytes)
  if (mode === 'background') {
    throw createBudgetError('App asset cache budget reached', ASSET_BUDGET_BACKGROUND_DENIED)
  }

  if (typeof requestConfirmation !== 'function') {
    throw createBudgetError('App asset cache budget needs confirmation', ASSET_BUDGET_DENIED_BY_USER)
  }

  try {
    await requestConfirmation({
      appId,
      filename,
      currentApprovedBytes: current.approvedBytes,
      nextApprovedBytes,
      projectedBytes
    })
  } catch (err) {
    err.code ??= ASSET_BUDGET_DENIED_BY_USER
    throw err
  }

  return writeAssetBudgetState({
    ...current,
    approvedBytes: nextApprovedBytes
  }, { appId, ...deps })
}
