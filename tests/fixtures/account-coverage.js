import { indexedDB } from 'fake-indexeddb'
import { createAccountEventCoverage } from '../../src/services/account-event-coverage.js'
import { NOSTRDB_ACCOUNT_COVERAGE_STORE } from '../../src/constants/storage-schema.js'

export async function coverageFixture (t) {
  const name = crypto.randomUUID()
  let db
  const open = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(NOSTRDB_ACCOUNT_COVERAGE_STORE, { keyPath: 'key' })
    req.onsuccess = () => { db = req.result; resolve(db) }
    req.onerror = () => reject(req.error)
  })
  await open()
  t.after(() => db.close())
  const make = () => createAccountEventCoverage('owner', { open: async () => db })
  return { make, db, coverage: make() }
}
