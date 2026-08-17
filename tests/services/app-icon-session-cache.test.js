import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  cacheDirectIconFallback,
  getDirectIconFallback,
  getDirectIconFallbackByAppId
} from '#services/app-icon-session-cache.js'

describe('app-icon session cache', () => {
  it('stores a direct fallback by appId + manifestId and exposes the appId alias', () => {
    const icon = { fx: 'root', url: 'https://blossom.example/root', persistable: false }

    cacheDirectIconFallback({ appId: 'app-session-1', manifestId: 'manifest-1', icon })

    assert.equal(getDirectIconFallback({ appId: 'app-session-1', manifestId: 'manifest-1' }), icon)
    assert.equal(getDirectIconFallbackByAppId('app-session-1'), icon)
    assert.equal(getDirectIconFallback({ appId: 'app-session-1', manifestId: 'manifest-2' }), null)
  })

  it('ignores entries without an appId or URL', () => {
    cacheDirectIconFallback({ appId: 'app-session-2', manifestId: 'manifest-1', icon: {} })
    cacheDirectIconFallback({ appId: null, manifestId: 'manifest-1', icon: { url: 'https://blossom.example/root' } })

    assert.equal(getDirectIconFallbackByAppId('app-session-2'), null)
  })
})
