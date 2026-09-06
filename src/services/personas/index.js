import { getRandomId } from '#helpers/misc.js'
import { base62ToBase16 } from 'libp2r2p/base62'
import { setWebStorageItem } from '#f'

import { normalizeUserPks, resolvePersonaUserPks, resolveSelectedPersonaId, readAppPersonaContext } from './model.js'
export { DEFAULT_PERSONA_ID, normalizeUserPks, getDefaultPersonaUserPks, resolvePersonaUserPks, isPersonaEligible, resolveSelectedPersonaId, readAppPersonaContext } from './model.js'
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
  cleanupPersonaReferences(localStorageArea)
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
  personaId = resolveSelectedPersonaId({
    ...readAppPersonaContext(key => readJson(localStorageArea, key), { wsKey, appId }),
    personaId
  })
  if (personaId == null) {
    delete wsSelections[appId]
  } else {
    wsSelections[appId] = personaId
  }
  if (Object.keys(wsSelections).length) selections[wsKey] = wsSelections
  else delete selections[wsKey]
  if (JSON.stringify(selections) !== JSON.stringify(readSelections(localStorageArea))) {
    writeSelections(localStorageArea, selections)
  }
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

  // writePersonas also clears selections that no longer have an eligible persona.
}

export function cleanupPersonaReferences (localStorageArea) {
  const selections = readSelections(localStorageArea)
  let changed = false
  for (const [wsKey, wsSelections] of Object.entries(selections)) {
    if (!wsSelections || typeof wsSelections !== 'object') continue
    for (const appId of Object.keys(wsSelections)) {
      const context = readAppPersonaContext(key => readJson(localStorageArea, key), { wsKey, appId })
      if (!resolveSelectedPersonaId(context)) {
        delete wsSelections[appId]
        changed = true
      }
    }
    if (!Object.keys(wsSelections).length) {
      delete selections[wsKey]
      changed = true
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
