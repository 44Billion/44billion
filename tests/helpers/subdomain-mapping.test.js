import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

mock.module('#f', {
  namedExports: {
    setWebStorageItem: (area, key, value) => {
      if (value === undefined) area.removeItem(key)
      else area.setItem(key, JSON.stringify(value))
    }
  }
})

const {
  allocateAppSubdomain,
  normalizeSubdomainFreeIds,
  releaseAppSubdomain
} = await import('../../src/helpers/subdomain-mapping.js')

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

describe('subdomain mapping helper', async () => {
  it('normalizes free ids as sorted unique numeric strings', async () => {
    assert.deepEqual(normalizeSubdomainFreeIds(['9', 2, '2', 'bad', -1, '01']), ['1', '2', '9'])
  })

  it('allocates from next id when no free id is available', async () => {
    const storage = signalStorage({ session_subdomainNextId: 7 })

    const subdomain = await allocateAppSubdomain(storage, { userPk: 'user', appId: 'app' })

    assert.equal(subdomain, '7')
    assert.equal(storage.session_subdomainNextId$(), 8)
    assert.equal(storage.session_subdomainByUserAndApp_user_app$(), '7')
    assert.deepEqual(storage.session_subdomainToApp_7$(), { userPk: 'user', appId: 'app' })
  })

  it('quarantines a released id before another allocation', async () => {
    const storage = signalStorage({ session_subdomainNextId: 3 })

    const first = await allocateAppSubdomain(storage, { userPk: 'user', appId: 'one' })
    await releaseAppSubdomain(storage, { userPk: 'user', appId: 'one', subdomain: first })
    const second = await allocateAppSubdomain(storage, { userPk: 'user', appId: 'two' })

    assert.equal(first, '3')
    assert.equal(second, '4')
    assert.equal(storage.session_subdomainNextId$(), 5)
    assert.deepEqual(storage.session_subdomainFreeIds$() ?? [], [])
    assert.equal(storage.session_subdomainByUserAndApp_user_one$(), undefined)
    assert.deepEqual(storage.local_subdomainLifecycle$().pending, ['3'])
  })

  it('skips stale free ids that are still mapped', async () => {
    const storage = signalStorage({
      session_subdomainNextId: 10,
      session_subdomainFreeIds: ['4', '6'],
      session_subdomainToApp_4: { userPk: 'other', appId: 'busy' }
    })

    const subdomain = await allocateAppSubdomain(storage, { userPk: 'user', appId: 'app' })

    assert.equal(subdomain, '10')
    assert.deepEqual(storage.session_subdomainFreeIds$() ?? [], [])
    assert.deepEqual(storage.session_subdomainToApp_4$(), { userPk: 'other', appId: 'busy' })
    assert.deepEqual(storage.session_subdomainToApp_10$(), { userPk: 'user', appId: 'app' })
  })

  it('returns the existing mapping instead of allocating a second id', async () => {
    const storage = signalStorage({
      session_subdomainNextId: 0,
      session_subdomainByUserAndApp_user_app: '3',
      session_subdomainToApp_3: { userPk: 'user', appId: 'app' }
    })

    assert.equal(await allocateAppSubdomain(storage, { userPk: 'user', appId: 'app' }), '3')
    assert.equal(storage.session_subdomainNextId$(), 0)
  })

  it('repairs a missing forward mapping when the reverse mapping exists', async () => {
    const storage = signalStorage({
      session_subdomainNextId: 2,
      session_subdomainToApp_1: { userPk: 'user', appId: 'app' }
    })

    assert.equal(await allocateAppSubdomain(storage, { userPk: 'user', appId: 'app' }), '1')
    assert.equal(storage.session_subdomainByUserAndApp_user_app$(), '1')
    assert.equal(storage.session_subdomainNextId$(), 2)
  })

  it('repairs a missing reverse mapping without changing the subdomain', async () => {
    const storage = signalStorage({
      session_subdomainNextId: 0,
      session_subdomainByUserAndApp_user_app: '3'
    })

    assert.equal(await allocateAppSubdomain(storage, { userPk: 'user', appId: 'app' }), '3')
    assert.deepEqual(storage.session_subdomainToApp_3$(), { userPk: 'user', appId: 'app' })
  })

  it('throws when the existing mapping conflicts with another app or user', async () => {
    const storage = signalStorage({
      session_subdomainNextId: 0,
      session_subdomainByUserAndApp_user_app: '3',
      session_subdomainToApp_3: { userPk: 'other', appId: 'other-app' }
    })

    await assert.rejects(
      () => allocateAppSubdomain(storage, { userPk: 'user', appId: 'app' }),
      /mapped to another app\/user/
    )
  })

  it('does not release a subdomain when the reverse mapping changed', async () => {
    const storage = signalStorage({
      session_subdomainByUserAndApp_user_app: '3',
      session_subdomainToApp_3: { userPk: 'other', appId: 'other-app' }
    })

    assert.equal(await releaseAppSubdomain(storage, { userPk: 'user', appId: 'app', subdomain: '3' }), false)
    assert.equal(storage.session_subdomainByUserAndApp_user_app$(), '3')
    assert.deepEqual(storage.session_subdomainToApp_3$(), { userPk: 'other', appId: 'other-app' })
  })
})
