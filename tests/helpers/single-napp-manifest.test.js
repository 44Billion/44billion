import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeSingleNappOpenedAtByOwner,
  withSingleNappOpenedAtByOwner
} from '../../src/services/idb/browser/queries/site-manifest.js'

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
})
