import { base16ToBase62 } from 'libp2r2p/base62'
import { NOSTRDB_PENDING_DELETIONS_KEY } from '#constants/storage-schema.js'

const listeners = new Set()
const error = code => Object.assign(new Error(code), { code })
export function readPendingNostrDbDeletions (storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(NOSTRDB_PENDING_DELETIONS_KEY) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

export function assertNostrDbAccountFlags ({ isDefaultUser, isReadOnly } = {}) {
  if (isDefaultUser) throw error('READ_ONLY_TEMPORARY_ACCOUNT')
  if (isReadOnly) throw error('READ_ONLY_ACCOUNT')
}

export function assertNostrDbAccess (owner, { storage = globalThis.localStorage } = {}) {
  if (!storage) return
  const pk = base16ToBase62(owner, { mode: 'integer', minLength: 43 })
  assertNostrDbAccountFlags({
    isDefaultUser: storage.getItem('session_defaultUserPk') === JSON.stringify(pk),
    isReadOnly: storage.getItem(`session_accountByUserPk_${pk}_isReadOnly`) === 'true'
  })
  if (Object.hasOwn(readPendingNostrDbDeletions(storage), owner)) throw error('NOSTRDB_DELETION_PENDING')
}

export function isNostrDbAccessError (error) {
  return ['READ_ONLY_ACCOUNT', 'READ_ONLY_TEMPORARY_ACCOUNT', 'NOSTRDB_DELETION_PENDING', 'NOSTRDB_RESET'].includes(error?.code)
}

export function notifyNostrDbAccessChanged () {
  for (const listener of [...listeners]) listener()
}

export function watchNostrDbAccess (listener) {
  listeners.add(listener)
  const onStorage = event => {
    if (event.key === null || event.key === NOSTRDB_PENDING_DELETIONS_KEY || event.key === 'session_defaultUserPk' || event.key?.endsWith('_isReadOnly')) listener()
  }
  globalThis.addEventListener?.('storage', onStorage)
  return () => { listeners.delete(listener); globalThis.removeEventListener?.('storage', onStorage) }
}
