import { base16ToBase62, base62ToBase16 } from 'libp2r2p/base62'
import { setWebStorageItem } from '#f'
import { deleteNostrDb } from './idb/nostrdb/index.js'
import { NOSTRDB_PENDING_DELETIONS_KEY as KEY } from '#constants/storage-schema.js'
import { readPendingNostrDbDeletions, notifyNostrDbAccessChanged } from './idb/nostrdb/access.js'

const HEX = /^[0-9a-f]{64}$/
const withLock = callback => {
  if (!globalThis.navigator?.locks?.request) throw new Error('NostrDB lifecycle coordination unavailable')
  return navigator.locks.request('44billion:nostrdb-account-access:v1', callback)
}

// The persistent intent also fences a rapid read-only -> writable transition.
// Keep this lock until both the owner DB and shared chunk references are gone.
export async function reconcileNostrDbAccounts (accounts, {
  storage = globalThis.localStorage, write = setWebStorageItem,
  lock = withLock, deleteDb = deleteNostrDb, reportError = console.error, scanReadOnly = false
} = {}) {
  if (!storage) return
  return lock(async () => {
    const pending = readPendingNostrDbDeletions(storage)
    // Read persisted flags only after acquiring the lock: a queued startup must
    // not restore an obsolete read-only state over a newer vault notification.
    if (scanReadOnly) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        const match = /^session_accountByUserPk_(.+)_isReadOnly$/.exec(key)
        if (!match || storage.getItem(key) !== 'true') continue
        try {
          const owner = base62ToBase16(match[1], { mode: 'integer', byteLength: 32 })
          if (HEX.test(owner)) pending[owner] ??= crypto.randomUUID()
        } catch {}
      }
    }
    for (const account of accounts ?? []) {
      const owner = account.pubkey?.toLowerCase()
      if (!HEX.test(owner ?? '')) continue
      const pk = base16ToBase62(owner, { mode: 'integer', minLength: 43 })
      write(storage, `session_accountByUserPk_${pk}_isReadOnly`, !!account.isReadOnly)
      if (account.isReadOnly) pending[owner] ??= crypto.randomUUID()
    }
    if (!accounts?.length && !Object.keys(pending).length) return
    write(storage, KEY, Object.keys(pending).length ? pending : undefined)
    notifyNostrDbAccessChanged()
    for (const owner of Object.keys(pending)) {
      if (!HEX.test(owner)) continue
      try {
        if (!await deleteDb(owner)) throw new Error('NostrDB deletion did not complete')
        delete pending[owner]
        write(storage, KEY, Object.keys(pending).length ? pending : undefined)
        notifyNostrDbAccessChanged()
      } catch (error) { reportError(error, { owner, phase: 'nostrdb-deletion' }) }
    }
  })
}

export function startNostrDbAccountMaintenance ({ storage = globalThis.localStorage, reportError = console.error } = {}) {
  let stopped = false
  let timer
  const run = async scanReadOnly => {
    try { await reconcileNostrDbAccounts([], { storage, reportError, scanReadOnly }) } catch (error) { reportError(error) }
    if (!stopped) { timer = setTimeout(() => run(false), 30000); timer.unref?.() }
  }
  run(true)
  return () => { stopped = true; clearTimeout(timer) }
}
