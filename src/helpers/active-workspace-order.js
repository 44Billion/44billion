export const SESSION_TAB_WORKSPACE_KEYS = 'session_tabWorkspaceKeys'
export const SESSION_OPEN_WORKSPACE_KEYS = 'session_openWorkspaceKeys'

function readJson (storage, key) {
  const raw = storage?.getItem?.(key)
  if (raw == null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function writeJson (storage, key, value) {
  if (value == null) storage?.removeItem?.(key)
  else storage?.setItem?.(key, JSON.stringify(value))
}

export function validWorkspaceOrder (keys, workspaceKeys) {
  const all = Array.isArray(workspaceKeys) ? workspaceKeys : []
  return (Array.isArray(keys) ? keys : []).filter(key => all.includes(key))
}

// Canonical order lives in localStorage (last write from any tab); each tab
// keeps its own order in sessionStorage and falls back to the canonical one.
export function readActiveWorkspaceOrder (storage, tabStorage) {
  const canonical = readJson(storage, SESSION_OPEN_WORKSPACE_KEYS)
  const canonicalOrder = Array.isArray(canonical) ? canonical : []
  const tabOrder = tabStorage ? readJson(tabStorage, SESSION_TAB_WORKSPACE_KEYS) : undefined
  return Array.isArray(tabOrder) && tabOrder.length > 0 ? tabOrder : canonicalOrder
}

export function initTabWorkspaceOrder ({ localStorageArea, sessionStorageArea }) {
  if (!sessionStorageArea) return readActiveWorkspaceOrder(localStorageArea, null)
  const existing = readJson(sessionStorageArea, SESSION_TAB_WORKSPACE_KEYS)
  if (Array.isArray(existing) && existing.length > 0) return existing
  const order = readActiveWorkspaceOrder(localStorageArea, null)
  writeJson(sessionStorageArea, SESSION_TAB_WORKSPACE_KEYS, order)
  return order
}

export function writeActiveWorkspaceOrder (storage, tabStorage, keys) {
  const next = Array.isArray(keys) ? keys : []
  if (tabStorage) writeJson(tabStorage, SESSION_TAB_WORKSPACE_KEYS, next)
  writeJson(storage, SESSION_OPEN_WORKSPACE_KEYS, next)
}
