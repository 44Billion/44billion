import { readAppPersonaContext, resolvePersonaUserPks } from './model.js'
import { readJson, userPksToHex } from './index.js'

export function readAppPersonaPublicKeys (record, storage = globalThis.localStorage) {
  return userPksToHex(resolvePersonaUserPks(
    readAppPersonaContext(key => readJson(storage, key), record)
  ))
}

export const publicKeysFingerprint = keys => JSON.stringify([...new Set(keys)].sort())

export function createPersonaPublicKeysService ({ read = readAppPersonaPublicKeys, reportError = console.error } = {}) {
  const documents = new Map()
  let queued = false
  return {
    invalidate () {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        for (const entry of documents.values()) {
          const keys = read(entry.record)
          const fingerprint = publicKeysFingerprint(keys)
          if (fingerprint === entry.fingerprint) continue
          entry.fingerprint = fingerprint
          try { entry.notify(keys) } catch (error) { reportError(error) }
        }
      })
    },
    connect (record, notify) {
      const initialPublicKeys = read(record)
      const entry = { record, notify, fingerprint: publicKeysFingerprint(initialPublicKeys) }
      documents.set(record.instanceKey, entry)
      return {
        initialPublicKeys,
        disconnect () {
          if (documents.get(record.instanceKey) === entry) documents.delete(record.instanceKey)
        }
      }
    }
  }
}

export const personaPublicKeys = createPersonaPublicKeysService()
