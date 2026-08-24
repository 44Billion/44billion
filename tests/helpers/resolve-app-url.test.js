import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { appDecode, appEncode, naddrEncode } from 'libp2r2p/nip19'
import { isAppUrl, resolveAppUrl } from '#helpers/resolve-app-url.js'
import router from '#zones/multi-napp/router.js'

describe('resolve-app-url', () => {
  it('recognizes entities, named account URLs and hardcoded aliases', () => {
    assert.equal(isAppUrl('+3swFhu23QNl8er5yOtc8bf9ueHCdwF8CzoDUiSSwwKIWoS8Ki5TwMyeA3Js1'), true)
    assert.equal(isAppUrl('+apps'), true)
    assert.equal(isAppUrl('+app store'), true)
    assert.equal(isAppUrl('+example@fiatjaf.com'), true)
    assert.equal(isAppUrl('+example'), false)
    assert.equal(isAppUrl(`+${'a'.repeat(48)}`), false)
    assert.equal(isAppUrl('+'), false)
  })

  it('matches named and percent-encoded routes through the multi-napp router', () => {
    const match = router.find('/+caf%C3%A9@bob@example.com/rota')
    assert.equal(match.params.appPath, '/rota')
    assert.equal(match.params.napp, '+café@bob@example.com')

    const alias = router.find('/+app%20store')
    assert.equal(alias.params.appPath, '')
    assert.equal(alias.params.napp, '+app store')
  })

  it('recognizes and canonicalizes site-manifest naddr URLs', async () => {
    const pubkey = 'ab'.repeat(32)
    const naddr = naddrEncode({ identifier: 'apps', pubkey, kind: 35128 })
    const expected = appEncode({ dTag: 'apps', pubkey, kind: 35128 })

    assert.equal(isAppUrl(naddr), true)
    assert.equal(await resolveAppUrl(naddr), expected)

    const nonManifest = naddrEncode({ identifier: 'note', pubkey, kind: 1 })
    assert.equal(isAppUrl(nonManifest), false)
    assert.equal(await resolveAppUrl(nonManifest), null)
  })

  it('matches bare naddr routes through the multi-napp router', () => {
    const naddr = naddrEncode({
      identifier: 'apps',
      pubkey: 'ab'.repeat(32),
      kind: 35128
    })
    const match = router.find(`/${naddr}/rota`)

    assert.equal(match.params.appPath, '/rota')
    assert.equal(match.params.napp, naddr)
  })

  it('resolves hardcoded aliases without network lookups', async () => {
    assert.equal(
      await resolveAppUrl('+apps'),
      '+3swFhu23QNl8er5yOtc8bf9ueHCdwF8CzoDUiSSwwKIWoS8Ki5TwMyeA3Js1'
    )
  })

  it('resolves named URLs through account lookup, relays and site manifest', async () => {
    const pubkey = 'ab'.repeat(32)
    const entity = await resolveAppUrl('+meu-app@fiatjaf.com', {
      _resolveUserReference: async () => ({
        pubkey,
        relays: ['wss://nip05-relay.test'],
        label: 'fiatjaf.com'
      }),
      _getRelaysByPubkey: async () => ({
        [pubkey]: { write: ['wss://write-relay.test'] }
      }),
      _getSiteManifest: async (address, relays) => {
        assert.equal(address.pubkey, pubkey)
        assert.equal(address.kind, 35128)
        assert.equal(address.dTag, 'meu-app')
        assert.ok(relays.write.includes('wss://nip05-relay.test'))
        assert.ok(relays.write.includes('wss://write-relay.test'))
        return { id: '1'.repeat(64) }
      }
    })

    const decoded = appDecode(entity)
    assert.equal(decoded.dTag, 'meu-app')
    assert.equal(decoded.pubkey, pubkey)
    assert.equal(decoded.kind, 35128)
    assert.deepEqual(decoded.relays, ['wss://nip05-relay.test', 'wss://write-relay.test'])
  })

  it('returns null when account or manifest resolution fails', async () => {
    assert.equal(await resolveAppUrl('+app@fiatjaf.com', {
      _resolveUserReference: async () => null
    }), null)

    assert.equal(await resolveAppUrl('+app@fiatjaf.com', {
      _resolveUserReference: async () => ({ pubkey: 'ab'.repeat(32), relays: [], label: 'x' }),
      _getRelaysByPubkey: async () => ({}),
      _getSiteManifest: async () => null
    }), null)
  })
})
