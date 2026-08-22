import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  allocateAppSubdomain,
  normalizeSubdomainFreeIds,
  releaseAppSubdomain
} from '../../src/helpers/subdomain-mapping.js'

function signalStorage (entries = {}) {
  const data = new Map(Object.entries(entries))
  return new Proxy({}, {
    get (_target, key) {
      if (typeof key !== 'string' || !key.endsWith('$')) return undefined
      const storageKey = key.slice(0, -1)
      return (...args) => {
        if (args.length === 0) return data.get(storageKey)
        const value = args[0]
        if (value === undefined) data.delete(storageKey)
        else data.set(storageKey, value)
        return value
      }
    }
  })
}

describe('subdomain mapping helper', () => {
  it('normalizes free ids as sorted unique numeric strings', () => {
    assert.deepEqual(normalizeSubdomainFreeIds(['9', 2, '2', 'bad', -1, '01']), ['1', '2', '9'])
  })

  it('allocates from next id when no free id is available', () => {
    const storage = signalStorage({ session_subdomainNextId: 7 })

    const subdomain = allocateAppSubdomain(storage, { userPk: 'user', appId: 'app' })

    assert.equal(subdomain, '7')
    assert.equal(storage.session_subdomainNextId$(), 8)
    assert.equal(storage.session_subdomainByUserAndApp_user_app$(), '7')
    assert.deepEqual(storage.session_subdomainToApp_7$(), { userPk: 'user', appId: 'app' })
  })

  it('reuses a released id before consuming next id', () => {
    const storage = signalStorage({ session_subdomainNextId: 3 })

    const first = allocateAppSubdomain(storage, { userPk: 'user', appId: 'one' })
    releaseAppSubdomain(storage, { userPk: 'user', appId: 'one', subdomain: first })
    const second = allocateAppSubdomain(storage, { userPk: 'user', appId: 'two' })

    assert.equal(first, '3')
    assert.equal(second, '3')
    assert.equal(storage.session_subdomainNextId$(), 4)
    assert.equal(storage.session_subdomainFreeIds$(), undefined)
    assert.equal(storage.session_subdomainByUserAndApp_user_one$(), undefined)
    assert.deepEqual(storage.session_subdomainToApp_3$(), { userPk: 'user', appId: 'two' })
  })

  it('skips stale free ids that are still mapped', () => {
    const storage = signalStorage({
      session_subdomainNextId: 10,
      session_subdomainFreeIds: ['4', '6'],
      session_subdomainToApp_4: { userPk: 'other', appId: 'busy' }
    })

    const subdomain = allocateAppSubdomain(storage, { userPk: 'user', appId: 'app' })

    assert.equal(subdomain, '6')
    assert.equal(storage.session_subdomainFreeIds$(), undefined)
    assert.deepEqual(storage.session_subdomainToApp_4$(), { userPk: 'other', appId: 'busy' })
    assert.deepEqual(storage.session_subdomainToApp_6$(), { userPk: 'user', appId: 'app' })
  })

  it('returns the existing mapping instead of allocating a second id', () => {
    const storage = signalStorage({
      session_subdomainNextId: 0,
      session_subdomainByUserAndApp_user_app: '3',
      session_subdomainToApp_3: { userPk: 'user', appId: 'app' }
    })

    assert.equal(allocateAppSubdomain(storage, { userPk: 'user', appId: 'app' }), '3')
    assert.equal(storage.session_subdomainNextId$(), 0)
  })

  it('repairs a missing forward mapping when the reverse mapping exists', () => {
    const storage = signalStorage({
      session_subdomainNextId: 2,
      session_subdomainToApp_1: { userPk: 'user', appId: 'app' }
    })

    assert.equal(allocateAppSubdomain(storage, { userPk: 'user', appId: 'app' }), '1')
    assert.equal(storage.session_subdomainByUserAndApp_user_app$(), '1')
    assert.equal(storage.session_subdomainNextId$(), 2)
  })

  it('repairs a missing reverse mapping without changing the subdomain', () => {
    const storage = signalStorage({
      session_subdomainNextId: 0,
      session_subdomainByUserAndApp_user_app: '3'
    })

    assert.equal(allocateAppSubdomain(storage, { userPk: 'user', appId: 'app' }), '3')
    assert.deepEqual(storage.session_subdomainToApp_3$(), { userPk: 'user', appId: 'app' })
  })

  it('throws when the existing mapping conflicts with another app or user', () => {
    const storage = signalStorage({
      session_subdomainNextId: 0,
      session_subdomainByUserAndApp_user_app: '3',
      session_subdomainToApp_3: { userPk: 'other', appId: 'other-app' }
    })

    assert.throws(
      () => allocateAppSubdomain(storage, { userPk: 'user', appId: 'app' }),
      /mapped to another app\/user/
    )
  })

  it('does not release a subdomain when the reverse mapping changed', () => {
    const storage = signalStorage({
      session_subdomainByUserAndApp_user_app: '3',
      session_subdomainToApp_3: { userPk: 'other', appId: 'other-app' }
    })

    assert.equal(releaseAppSubdomain(storage, { userPk: 'user', appId: 'app', subdomain: '3' }), false)
    assert.equal(storage.session_subdomainByUserAndApp_user_app$(), '3')
    assert.deepEqual(storage.session_subdomainToApp_3$(), { userPk: 'other', appId: 'other-app' })
  })
})
