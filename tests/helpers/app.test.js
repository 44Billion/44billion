import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addressObjToAppId, appIdToAddressObj } from '#helpers/app.js'

describe('App helpers', () => {
  describe('addressObjToAppId and appIdToAddressObj', () => {
    it('should convert address object to app ID and back correctly', () => {
      const addressObj = {
        kind: 35128,
        pubkey: 'fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52',
        dTag: '44b'
      }

      const appId = addressObjToAppId(addressObj)
      const result = appIdToAddressObj(appId)

      assert.deepEqual(result, addressObj)
    })

    it('preserves a 32-byte pubkey with leading zero bytes', () => {
      const addressObj = {
        kind: 35130,
        pubkey: '000001' + '23'.repeat(29),
        dTag: 'leading-zero'
      }

      const appId = addressObjToAppId(addressObj)
      assert.equal(appId.slice(1, 44).length, 43)
      assert.deepEqual(appIdToAddressObj(appId), addressObj)
    })
  })
})
