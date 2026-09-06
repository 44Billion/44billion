export const DEFAULT_PERSONA_ID = '__default__'

export function normalizeUserPks (userPks) {
  if (!Array.isArray(userPks)) return []
  return [...new Set(userPks.filter(pk => typeof pk === 'string' && pk.length > 0))]
}

export function getDefaultPersonaUserPks ({ accountUserPks, defaultUserPk }) {
  const real = normalizeUserPks(accountUserPks).filter(pk => pk !== defaultUserPk)
  if (real.length) return real
  return typeof defaultUserPk === 'string' && defaultUserPk ? [defaultUserPk] : []
}

export function getPersonaMembers ({ personaId, personas, ...context }) {
  return personaId === DEFAULT_PERSONA_ID
    ? getDefaultPersonaUserPks(context)
    : normalizeUserPks(personas?.[personaId]?.userPks)
}

export function isPersonaEligible (context) {
  return !!context.personaId && getPersonaMembers(context).includes(context.workspaceUserPk)
}

// Reads are safe even before a persisted invalid selection has been cleaned up.
export function resolveSelectedPersonaId (context) {
  return isPersonaEligible(context) ? context.personaId : null
}

export function resolvePersonaUserPks (context) {
  return isPersonaEligible(context)
    ? getPersonaMembers(context)
    : normalizeUserPks([context.workspaceUserPk])
}

// The reader can use storage snapshots, live localStorage, or reactive signals.
export function readAppPersonaContext (read, { wsKey, appId, instanceUserPk } = {}) {
  return {
    personaId: read('local_appPersonaSelections')?.[wsKey]?.[appId] ?? null,
    personas: read('local_personas') ?? {},
    accountUserPks: read('session_accountUserPks') ?? [],
    defaultUserPk: read('session_defaultUserPk'),
    workspaceUserPk: read(`session_workspaceByKey_${wsKey}_userPk`) ?? instanceUserPk
  }
}
