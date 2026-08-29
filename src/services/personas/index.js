import { getRandomId } from '#helpers/misc.js'
import { base62ToBase16 } from 'libp2r2p/base62'
import { setWebStorageItem } from '#f'

export const DEFAULT_PERSONA_ID = '__default__'
export const LOCAL_PERSONAS = 'local_personas'
export const LOCAL_APP_PERSONA_SELECTIONS = 'local_appPersonaSelections'

export function readJson (storage, key, fallback = undefined) {
  const raw = storage?.getItem?.(key)
  if (raw == null) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function writeJson (storage, key, value) {
  setWebStorageItem(storage, key, value === null ? undefined : value)
}

export function normalizeUserPks (userPks) {
  if (!Array.isArray(userPks)) return []
  return [...new Set(userPks.filter(pk => typeof pk === 'string' && pk.length > 0))]
}

// The default persona is virtual: it always contains the current users, so it
// can never become stale and cannot be deleted. The default (read-only) user
// only appears when there are no real connected accounts.
export function getDefaultPersonaUserPks ({ accountUserPks, defaultUserPk }) {
  const all = normalizeUserPks(accountUserPks)
  const real = all.filter(pk => pk !== defaultUserPk)
  if (real.length > 0) return real
  return typeof defaultUserPk === 'string' && defaultUserPk ? [defaultUserPk] : []
}

// Returns the base62 pubkeys of the active persona for an app instance.
// `workspaceUserPk` is the fallback when no persona is selected.
export function resolvePersonaUserPks ({
  personaId,
  personas,
  accountUserPks,
  defaultUserPk,
  workspaceUserPk
}) {
  if (personaId == null || personaId === '') {
    return typeof workspaceUserPk === 'string' && workspaceUserPk ? [workspaceUserPk] : []
  }
  if (personaId === DEFAULT_PERSONA_ID) {
    return getDefaultPersonaUserPks({ accountUserPks, defaultUserPk })
  }
  const persona = personas?.[personaId]
  return normalizeUserPks(persona?.userPks)
}

export function isUserPkInActivePersona ({ userPk, ...rest }) {
  return resolvePersonaUserPks(rest).includes(userPk)
}

export function userPksToHex (userPks) {
  return normalizeUserPks(userPks)
    .map(pk => {
      try {
        return base62ToBase16(pk, { mode: 'integer', byteLength: 32 }).toLowerCase()
      } catch {
        return null
      }
    })
    .filter(pk => typeof pk === 'string')
}

export function readPersonas (localStorageArea) {
  const personas = readJson(localStorageArea, LOCAL_PERSONAS, {})
  return personas && typeof personas === 'object' ? personas : {}
}

export function writePersonas (localStorageArea, personas) {
  writeJson(localStorageArea, LOCAL_PERSONAS, personas)
}

export function readSelections (localStorageArea) {
  const selections = readJson(localStorageArea, LOCAL_APP_PERSONA_SELECTIONS, {})
  return selections && typeof selections === 'object' ? selections : {}
}

export function writeSelections (localStorageArea, selections) {
  writeJson(localStorageArea, LOCAL_APP_PERSONA_SELECTIONS, selections)
}

export function getAppPersonaSelection ({ localStorageArea, wsKey, appId }) {
  const selections = readSelections(localStorageArea)
  const wsSelections = selections?.[wsKey]
  if (!wsSelections || typeof wsSelections !== 'object') return null
  const personaId = wsSelections[appId]
  return typeof personaId === 'string' && personaId ? personaId : null
}

export function setAppPersonaSelection ({
  localStorageArea,
  wsKey,
  appId,
  personaId,
  now = Date.now()
}) {
  const selections = readSelections(localStorageArea)
  const wsSelections = selections[wsKey] ?? {}
  if (personaId == null || personaId === '') {
    delete wsSelections[appId]
  } else {
    wsSelections[appId] = personaId
  }
  selections[wsKey] = wsSelections
  writeSelections(localStorageArea, selections)
  return now
}

export function removeSelectionsForWorkspace ({ localStorageArea, wsKey }) {
  const selections = readSelections(localStorageArea)
  if (!selections[wsKey]) return
  delete selections[wsKey]
  writeSelections(localStorageArea, selections)
}

export function removeSelectionsForAppInWorkspace ({ localStorageArea, wsKey, appId }) {
  const selections = readSelections(localStorageArea)
  const wsSelections = selections[wsKey]
  if (!wsSelections || typeof wsSelections !== 'object' || !(appId in wsSelections)) return
  delete wsSelections[appId]
  if (Object.keys(wsSelections).length === 0) delete selections[wsKey]
  writeSelections(localStorageArea, selections)
}

export function addPersona ({
  localStorageArea,
  userPks,
  personaId = getRandomId(),
  now = Date.now()
}) {
  const clean = normalizeUserPks(userPks)
  if (clean.length === 0) throw new Error('Persona must have at least one pubkey')
  const personas = readPersonas(localStorageArea)
  personas[personaId] = {
    userPks: clean,
    createdAt: now,
    updatedAt: now
  }
  writePersonas(localStorageArea, personas)
  return personaId
}

export function updatePersonaUserPks ({
  localStorageArea,
  personaId,
  userPks,
  now = Date.now()
}) {
  const personas = readPersonas(localStorageArea)
  const persona = personas[personaId]
  if (!persona) throw new Error(`Persona not found: ${personaId}`)
  const clean = normalizeUserPks(userPks)
  if (clean.length === 0) throw new Error('Persona must have at least one pubkey')
  persona.userPks = clean
  persona.updatedAt = now
  writePersonas(localStorageArea, personas)
  return persona
}

export function removePersona ({ localStorageArea, personaId }) {
  const personas = readPersonas(localStorageArea)
  delete personas[personaId]
  writePersonas(localStorageArea, personas)

  // Clear every selection that referenced the removed persona.
  const selections = readSelections(localStorageArea)
  let changed = false
  for (const [, wsSelections] of Object.entries(selections)) {
    if (!wsSelections || typeof wsSelections !== 'object') continue
    for (const [appId, selectedId] of Object.entries(wsSelections)) {
      if (selectedId === personaId) {
        delete wsSelections[appId]
        changed = true
      }
    }
  }
  if (changed) writeSelections(localStorageArea, selections)
}

export function cleanupPersonaReferences (localStorageArea) {
  const personas = readPersonas(localStorageArea)
  const selections = readSelections(localStorageArea)
  let changed = false
  for (const [, wsSelections] of Object.entries(selections)) {
    if (!wsSelections || typeof wsSelections !== 'object') continue
    for (const [appId, personaId] of Object.entries(wsSelections)) {
      if (
        personaId !== DEFAULT_PERSONA_ID &&
        (!personas[personaId] || normalizeUserPks(personas[personaId].userPks).length === 0)
      ) {
        delete wsSelections[appId]
        changed = true
      }
    }
  }
  if (changed) writeSelections(localStorageArea, selections)
}

export function normalizePersonas (localStorageArea) {
  const personas = readPersonas(localStorageArea)
  let changed = false
  for (const [personaId, persona] of Object.entries(personas)) {
    if (
      !persona ||
      typeof persona !== 'object' ||
      normalizeUserPks(persona.userPks).length === 0
    ) {
      delete personas[personaId]
      changed = true
    }
  }
  if (changed) writePersonas(localStorageArea, personas)
  cleanupPersonaReferences(localStorageArea)
  return personas
}
