import { toSignal, useTask } from '#f'
import { readQuotaState, subscribeQuotaState, startGlobalQuotaMaintenance } from '#services/idb/nostrdb/quotas.js'

const state$ = toSignal(null)

// Initialize once in the stable screen root; readers own no external listeners.
export function useInitQuotaState () {
  useTask(({ cleanup }) => {
    state$(readQuotaState())
    cleanup(subscribeQuotaState(state$))
    cleanup(startGlobalQuotaMaintenance())
  })
}

export function useQuotaState () { return state$ }
