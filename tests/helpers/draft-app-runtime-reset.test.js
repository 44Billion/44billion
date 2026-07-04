import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { resetDraftAppRuntimeData } from '../../src/components/zones/screen/helpers/draft-app-runtime-reset.js'

describe('draft app runtime reset helper', () => {
  it('clears app origin data and owner-scoped NostrDB rows', async () => {
    const ownerPubkey = 'a'.repeat(64)
    const cleared = []
    const deleted = []

    assert.equal(await resetDraftAppRuntimeData({
      appId: 'draft-app',
      userPk: 'owner-pk',
      appSubdomain: '42',
      _askAppToClearData: async appSubdomain => { cleared.push(appSubdomain) },
      _base62ToBase16: () => ownerPubkey,
      _getNostrDb: owner => ({
        async deleteEventsByApp (appId) { deleted.push({ owner, appId }) }
      })
    }), true)

    assert.deepEqual(cleared, ['42'])
    assert.deepEqual(deleted, [{ owner: ownerPubkey, appId: 'draft-app' }])
  })

  it('continues when clearing or NostrDB deletion fails', async () => {
    const warnings = []

    assert.equal(await resetDraftAppRuntimeData({
      appId: 'draft-app',
      userPk: 'owner-pk',
      appSubdomain: '42',
      _askAppToClearData: async () => { throw new Error('clear failed') },
      _base62ToBase16: () => { throw new Error('bad owner') },
      _console: { warn: (...args) => warnings.push(args) }
    }), true)

    assert.equal(warnings.length, 2)
    assert.match(warnings[0][0], /origin data/)
    assert.match(warnings[1][0], /NostrDB/)
  })

  it('does nothing without an app id', async () => {
    const clear = mock.fn(async () => {})

    assert.equal(await resetDraftAppRuntimeData({
      appId: '',
      _askAppToClearData: clear
    }), false)
    assert.equal(clear.mock.callCount(), 0)
  })
})
