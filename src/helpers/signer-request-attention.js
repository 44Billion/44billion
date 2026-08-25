import { toSignal } from '#f'

export const SIGNER_REQUEST_ATTENTION_MS = 6000

export const signerRequestAttention$ = toSignal(null)

let sequence = 0

// Coalesces attention requests: while the same kind+user is active (within
// the attention window), repeated requests do not reopen the tooltip.
export function requestSignerAttention ({ kind, userPk }) {
  const current = signerRequestAttention$()
  if (
    current &&
    current.kind === kind &&
    current.userPk === userPk &&
    current.expiresAt > Date.now()
  ) return false

  signerRequestAttention$({
    id: ++sequence,
    kind,
    userPk,
    expiresAt: Date.now() + SIGNER_REQUEST_ATTENTION_MS
  })
  return true
}

export function clearSignerRequestAttention () {
  signerRequestAttention$(null)
}

// useWebStorage serializes values with JSON.stringify, so both the workspace
// list and the workspace userPk must be parsed before comparing.
export function isActiveWorkspaceUser (
  userPk,
  storage = globalThis.localStorage,
  tabStorage = globalThis.sessionStorage
) {
  try {
    const tabOrder = JSON.parse(tabStorage?.getItem?.('session_tabWorkspaceKeys') ?? 'null')
    const canonical = JSON.parse(storage?.getItem?.('session_openWorkspaceKeys') ?? '[]')
    const openWorkspaceKeys = Array.isArray(tabOrder) && tabOrder.length > 0
      ? tabOrder
      : (Array.isArray(canonical) ? canonical : [])
    const wsKey = openWorkspaceKeys?.[0]
    if (!wsKey) return false
    const storedUserPk = JSON.parse(storage?.getItem(`session_workspaceByKey_${wsKey}_userPk`) ?? 'null')
    return storedUserPk === userPk
  } catch {
    return false
  }
}
