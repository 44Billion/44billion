import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  EVENT_READ_PERMISSION,
  EVENT_WRITE_PERMISSION,
  ONE_TIME_DELETE_PERMISSION,
  eventWritePermissionRequestsForEvent,
  deletionTargetKinds,
  permissionNamesForLookup
} from '#helpers/window-message/browser/event-permissions.js'

const PUBKEY = 'a'.repeat(64)

describe('event permissions', () => {
  it('makes write grants satisfy read lookups without honoring old grant names', () => {
    assert.deepEqual(permissionNamesForLookup(EVENT_READ_PERMISSION), [EVENT_READ_PERMISSION, EVENT_WRITE_PERMISSION])
    assert.deepEqual(permissionNamesForLookup(EVENT_WRITE_PERMISSION), [EVENT_WRITE_PERMISSION])
    assert.deepEqual(permissionNamesForLookup('encrypt'), ['encrypt'])
    assert.equal(permissionNamesForLookup(EVENT_READ_PERMISSION).includes('decrypt'), false)
    assert.equal(permissionNamesForLookup(EVENT_WRITE_PERMISSION).includes('signEvent'), false)
  })

  it('extracts deletion target kinds only when every deletion target is a valid address tag', () => {
    assert.deepEqual(deletionTargetKinds({
      tags: [
        ['a', `30023:${PUBKEY}:article`],
        ['a', `1:${PUBKEY}:`],
        ['p', PUBKEY]
      ]
    }), [1, 30023])

    assert.equal(deletionTargetKinds({ tags: [['e', 'b'.repeat(64)]] }), null)
    assert.equal(deletionTargetKinds({ tags: [['a', 'not-an-address']] }), null)
  })

  it('maps deletions with address targets to target writes and otherwise to one-time delete', () => {
    assert.deepEqual(eventWritePermissionRequestsForEvent({
      kind: 5,
      tags: [['a', `1:${PUBKEY}:note`]]
    }), [{ name: EVENT_WRITE_PERMISSION, eKind: 1 }])

    assert.deepEqual(eventWritePermissionRequestsForEvent({
      kind: 5,
      tags: [['e', 'b'.repeat(64)]]
    }), [{ name: ONE_TIME_DELETE_PERMISSION, eKind: 5, remember: false }])
  })
})
