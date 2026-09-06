import { useStore, useWebStorage } from '#f'
import { base62ToBase16 } from 'libp2r2p/base62'
import { DEFAULT_PERSONA_ID, getPersonaMembers, isPersonaEligible, readAppPersonaContext, resolveSelectedPersonaId } from '#services/personas/model.js'
import { setAppPersonaSelection } from '#services/personas/index.js'
import { personaT as t } from '#i18n/personas.js'

export function useAppPersona ({ wsKey$, appId$ }) {
  const storage = useWebStorage(localStorage)
  return useStore(() => ({
    context$ () {
      return readAppPersonaContext(key => storage[`${key}$`](), { wsKey: wsKey$(), appId: appId$() })
    },
    selectedId$ () { return resolveSelectedPersonaId(this.context$()) },
    userPk$ () { return this.context$().workspaceUserPk },
    userLabel (pk) {
      const profile = storage[`session_accountByUserPk_${pk}_profile$`]()
      if (profile?.name || profile?.display_name) return profile.name || profile.display_name
      if (!pk || pk === storage.session_defaultUserPk$()) return t('Workspace User')
      let label = profile?.npub
      if (!label) {
        try { label = base62ToBase16(pk, { mode: 'integer', byteLength: 32 }) } catch { label = pk }
      }
      return label.length > 20 ? `${label.slice(0, 8)}…${label.slice(-8)}` : label
    },
    options$ () {
      const context = this.context$()
      const ids = Object.keys(context.personas).filter(id => id !== DEFAULT_PERSONA_ID)
        .sort((a, b) => (context.personas[a]?.createdAt ?? 0) - (context.personas[b]?.createdAt ?? 0) || a.localeCompare(b))
      return [
        { id: null, label: this.userLabel(context.workspaceUserPk) },
        ...[DEFAULT_PERSONA_ID, ...ids]
          .filter(personaId => isPersonaEligible({ ...context, personaId }))
          .map(personaId => ({
            id: personaId,
            label: personaId === DEFAULT_PERSONA_ID
              ? t('All Users')
              : getPersonaMembers({ ...context, personaId }).map(pk => this.userLabel(pk)).join(', ')
          }))
      ]
    },
    select (personaId) {
      setAppPersonaSelection({ localStorageArea: localStorage, wsKey: wsKey$(), appId: appId$(), personaId })
    }
  }))
}
