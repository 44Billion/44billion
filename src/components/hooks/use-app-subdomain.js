import { useStore, useTask } from '#f'
import { subdomainStorage, isSubdomainStorageKey } from '#helpers/subdomain-mapping.js'

// Storage notifications are read-only here. Replaying their payload through a
// writable storage signal could overwrite a newer cross-tab allocation outside
// the mapping lock. Always resolve from the current storage value instead.
export function useAppSubdomain (getIdentity) {
  const state = useStore(() => ({
    revision$: 0,
    id$ () {
      this.revision$()
      const { userPk, appId } = getIdentity()
      return userPk && appId ? subdomainStorage()[`session_subdomainByUserAndApp_${userPk}_${appId}$`]() : null
    }
  }))
  useTask(({ cleanup }) => {
    const update = event => {
      if (event.storageArea === localStorage && (event.key === null || isSubdomainStorageKey(event.key))) state.revision$(value => value + 1)
    }
    window.addEventListener('storage', update)
    cleanup(() => window.removeEventListener('storage', update))
  })
  return state.id$
}
