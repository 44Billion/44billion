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

export function readAssetBudgetState ({ _localStorage } = {}) {
  return normalizeAssetBudgetState(
    safeJsonParse(getLocalStorage(_localStorage)?.getItem(STORAGE_KEY), null)
  )
}

export function writeAssetBudgetState (state, { _localStorage } = {}) {
  const storage = getLocalStorage(_localStorage)
  const next = normalizeAssetBudgetState(state)
  storage?.setItem(STORAGE_KEY, JSON.stringify(next))
  return next
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
  _countAllFileChunks,
  _streamAllFileChunks,
  _now = Date.now,
  ...deps
} = {}) {
  let chunkCount
  if (typeof _countAllFileChunks === 'function') {
    chunkCount = await _countAllFileChunks()
  } else {
    if (typeof _streamAllFileChunks !== 'function') throw new Error('Missing file chunk counter')
    chunkCount = 0
    for await (const _ of _streamAllFileChunks()) chunkCount++
  }
  const cachedBytes = normalizePositiveInteger(chunkCount) * APP_FILE_CHUNK_BYTES
  return writeAssetBudgetState({
    cachedBytes,
    approvedBytes: roundUpToStep(cachedBytes),
    rebuiltAt: _now()
  }, deps)
}

export async function ensureAssetBudgetInitialized ({
  _countAllFileChunks,
  _streamAllFileChunks,
  ...deps
} = {}) {
  const current = readAssetBudgetState(deps)
  if (!getLocalStorage(deps._localStorage)) return current
  if (current.rebuiltAt > 0) return current
  return rebuildAssetBudgetFromChunks({ _countAllFileChunks, _streamAllFileChunks, ...deps })
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
  if (!Number.isFinite(deltaBytes) || deltaBytes <= 0) return readAssetBudgetState(deps)

  const current = readAssetBudgetState(deps)
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
  }, deps)
}
