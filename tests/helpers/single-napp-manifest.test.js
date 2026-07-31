import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { indexedDB } from 'fake-indexeddb'
import { addressObjToAppId } from '../../src/helpers/app.js'

import {
  getSiteManifestFromDb,
  normalizeSingleNappOpenedAtByOwner,
  saveSiteManifestToDb,
  withSingleNappOpenedAtByOwner
} from '../../src/services/idb/browser/queries/site-manifest.js'

globalThis.indexedDB = indexedDB

describe('single-napp manifest metadata', () => {
  it('stores opened timestamps by owner pubkey', () => {
    const ownerA = 'a'.repeat(64)
    const ownerB = 'b'.repeat(64)

    const metadata = withSingleNappOpenedAtByOwner({
      singleNappOpenedAtByOwner: { [ownerA]: 1000 }
    }, ownerB, 2000)

    assert.deepEqual(metadata.singleNappOpenedAtByOwner, {
      [ownerA]: 1000,
      [ownerB]: 2000
    })
  })

  it('normalizes invalid owner-scoped single-napp metadata away', () => {
    const owner = 'c'.repeat(64)

    assert.deepEqual(normalizeSingleNappOpenedAtByOwner({
      [owner.toUpperCase()]: 3000,
      ['x'.repeat(64)]: 4000,
      ['d'.repeat(64)]: 0,
      notHex: 5000
    }), {
      [owner]: 3000
    })
  })

  it('round-trips aggregate update versions and ignores legacy event-id fields', async () => {
    const pubkey = 'a'.repeat(64)
    const dTag = 'version-storage'
    const appId = addressObjToAppId({ kind: 35128, pubkey, dTag })
    const event = {
      id: 'b'.repeat(64), sig: 'c'.repeat(128), pubkey, kind: 35128,
      created_at: 100, content: '',
      tags: [['d', dTag], ['path', 'index.html', 'd'.repeat(64)]]
    }
    await saveSiteManifestToDb(event, {
      latestUpdateVersion: '1'.repeat(64),
      seenUpdateVersion: '2'.repeat(64),
      latestUpdateEventId: 'legacy-latest',
      seenUpdateEventId: 'legacy-seen'
    })
    const stored = await getSiteManifestFromDb(appId)
    assert.equal(stored.meta.latestUpdateVersion, '1'.repeat(64))
    assert.equal(stored.meta.seenUpdateVersion, '2'.repeat(64))
    assert.equal(stored.meta.latestUpdateEventId, undefined)
    assert.equal(stored.meta.seenUpdateEventId, undefined)
  })
})
