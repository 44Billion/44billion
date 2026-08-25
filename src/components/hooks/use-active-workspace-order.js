import { useCallback, useComputed } from '#f'
import {
  validWorkspaceOrder
} from '#helpers/active-workspace-order.js'

export function useActiveWorkspaceOrder (storage, tabStorage) {
  const workspaceKeys$ = storage?.session_workspaceKeys$
  const canonical$ = storage?.session_openWorkspaceKeys$
  const tabOrder$ = tabStorage?.session_tabWorkspaceKeys$

  const order$ = useComputed(() => {
    const all = workspaceKeys$?.() ?? []
    const tab = tabOrder$?.()
    const canonical = canonical$?.()
    const tabKeys = Array.isArray(tab) ? tab : []
    const canonicalKeys = Array.isArray(canonical) ? canonical : []
    const preferred = tabKeys.length > 0
      ? validWorkspaceOrder(tabKeys, all)
      : validWorkspaceOrder(canonicalKeys, all)
    return preferred.length > 0 ? preferred : validWorkspaceOrder(canonicalKeys, all)
  })

  const setOrder = useCallback(keys => {
    const next = Array.isArray(keys) ? keys : []
    if (tabOrder$) tabOrder$(next)
    canonical$?.(next)
  })

  return { order$, setOrder }
}
