import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONTENT_KEY_ANNOUNCEMENT, CUSTOM_APP_DATA } from 'libp2r2p/kind'
import { accountKinds, shouldStoreAccountEvent } from '../../src/services/account-events.js'
import { toStoredRecord } from '../../src/services/idb/nostrdb/index.js'

test('known content-key announcements enter account import and remain shared between apps', () => {
  const event = {
    id: '1'.repeat(64),
    pubkey: '2'.repeat(64),
    kind: CONTENT_KEY_ANNOUNCEMENT,
    created_at: 1,
    tags: [['cp', '3'.repeat(64)]],
    content: '',
    sig: '4'.repeat(128)
  }
  const appRef = 'test-app'

  assert.ok(accountKinds.includes(CONTENT_KEY_ANNOUNCEMENT))
  assert.equal(shouldStoreAccountEvent(event), true)
  assert.equal(shouldStoreAccountEvent({ ...event, tags: [...event.tags, ['expiration', '1']] }), false)
  assert.equal('ap' in toStoredRecord(event, { appRef }), false)

  const appData = { ...event, kind: CUSTOM_APP_DATA, tags: [['d', 'settings']] }
  assert.equal(shouldStoreAccountEvent(appData), false)
  assert.deepEqual(toStoredRecord(appData, { appRef }).ap, [appRef])
})
