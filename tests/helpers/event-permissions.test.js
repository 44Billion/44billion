import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  EVENT_ACCESS_PERMISSION,
  EVENT_ACCESS_PERSONAL_PERMISSION,
  ONE_TIME_DELETE_PERMISSION,
  PERSONAL_COPY_WRAPPER_KIND,
  PRIVATE_CHANNEL_KIND,
  eventAccessPermissionRequestsForEvent,
  eventAccessPersonalPermissionRequestsForKind,
  deletionTargetKinds,
  permissionNamesForLookup
} from '#helpers/window-message/browser/event-permissions.js'

const PUBKEY = 'a'.repeat(64)

describe('event permissions', () => {
  it('uses exact unified access permission lookups', () => {
    assert.deepEqual(permissionNamesForLookup(EVENT_ACCESS_PERMISSION), [EVENT_ACCESS_PERMISSION])
    assert.deepEqual(permissionNamesForLookup('encrypt'), ['encrypt'])
    assert.equal(permissionNamesForLookup(EVENT_ACCESS_PERMISSION).includes('eventRead'), false)
    assert.equal(permissionNamesForLookup(EVENT_ACCESS_PERMISSION).includes('eventWrite'), false)
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

  it('maps deletions with address targets to target access and otherwise to one-time delete', () => {
    assert.deepEqual(eventAccessPermissionRequestsForEvent({
      kind: 5,
      tags: [['a', `1:${PUBKEY}:note`]]
    }), [{ name: EVENT_ACCESS_PERMISSION, eKind: 1 }])

    assert.deepEqual(eventAccessPermissionRequestsForEvent({
      kind: 5,
      tags: [['e', 'b'.repeat(64)]]
    }), [{ name: ONE_TIME_DELETE_PERMISSION, eKind: 5, remember: false }])
  })

  it('does not prompt for private-channel transport helper kinds', () => {
    assert.deepEqual(eventAccessPermissionRequestsForEvent({ kind: 26300, tags: [] }), [])
    assert.deepEqual(eventAccessPermissionRequestsForEvent({ kind: 26400, tags: [] }), [])
  })

  it('exempts protocol wrapper signing but keeps deletion target permissions', () => {
    for (const kind of [PRIVATE_CHANNEL_KIND, PERSONAL_COPY_WRAPPER_KIND]) {
      assert.deepEqual(eventAccessPermissionRequestsForEvent({ kind, tags: [] }), [])
      assert.deepEqual(eventAccessPermissionRequestsForEvent({
        kind: 5,
        tags: [['a', `${kind}:${PUBKEY}:`]]
      }), [{ name: EVENT_ACCESS_PERMISSION, eKind: kind }])
    }
    assert.deepEqual(eventAccessPermissionRequestsForEvent({
      kind: 5,
      tags: [['a', `26300:${PUBKEY}:`]]
    }), [])
  })

  it('uses logical personal kinds while exempting private-channel crypto transport', () => {
    for (const kind of [26300, 26400, PRIVATE_CHANNEL_KIND]) {
      assert.deepEqual(eventAccessPersonalPermissionRequestsForKind(kind), [])
    }
    assert.deepEqual(eventAccessPersonalPermissionRequestsForKind(1006), [
      { name: EVENT_ACCESS_PERSONAL_PERMISSION, eKind: 1006 }
    ])
    assert.deepEqual(eventAccessPersonalPermissionRequestsForKind(2), [
      { name: EVENT_ACCESS_PERSONAL_PERMISSION, eKind: 2 }
    ])
  })
})
