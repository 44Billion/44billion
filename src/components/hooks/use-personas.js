import { useTask } from '#f'
import { cleanupPersonaReferences } from '#services/personas/index.js'
import { personaPublicKeys } from '#services/personas/public-keys.js'

// One observer per launcher realm; consumers read the existing storage signals.
export function useInitPersonas ({ storage }) {
  useTask(({ track, cleanup }) => {
    track(() => {
      storage.local_personas$()
      const selections = storage.local_appPersonaSelections$() ?? {}
      storage.session_accountUserPks$()
      storage.session_defaultUserPk$()
      const workspaces = new Set([...(storage.session_workspaceKeys$() ?? []), ...Object.keys(selections)])
      for (const wsKey of workspaces) storage[`session_workspaceByKey_${wsKey}_userPk$`]()
    })
    // Signal setters notify observers before their proxy writes localStorage.
    // Resolve/repair after that write, and coalesce intermediate mutations.
    let active = true
    cleanup(() => { active = false })
    queueMicrotask(() => {
      if (!active) return
      cleanupPersonaReferences(localStorage)
      personaPublicKeys.invalidate()
    })
  })
}
