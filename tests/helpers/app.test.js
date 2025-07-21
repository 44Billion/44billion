import assert from 'node:assert/strict'
import { addressObjToAppId, appIdToAddressObj, pkToUserSubdomain, userSubdomainToPk } from '#helpers/app.js'

assert.deepEqual(appIdToAddressObj(addressObjToAppId({
  kind: 37448,
  pubkey: 'fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52',
  dTag: '44b'
})), {
  kind: 37448,
  pubkey: 'fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52',
  dTag: '44b'
})

const pk = 'fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52'
assert.equal(userSubdomainToPk(pkToUserSubdomain(pk)), pk)