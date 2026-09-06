import assert from 'node:assert/strict'
import { test, mock } from 'node:test'

mock.module('#f', {
  namedExports: {
    setWebStorageItem: (area, key, value) => {
      if (value === undefined) area.removeItem(key)
      else area.setItem(key, JSON.stringify(value))
    }
  }
})
const { subdomainStorage, allocateAppSubdomain, releaseAppSubdomain, retireSubdomainsFor } = await import('../../src/helpers/subdomain-mapping.js')
const { processSubdomainCleanup, reserveSubdomainUse } = await import('../../src/services/subdomain-cleanup.js')

function setup (entries = {}) {
  const data = new Map(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]))
  return subdomainStorage({
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
    key: index => [...data.keys()][index],
    get length () { return data.size }
  })
}

test('only confirmed cleanup permits recycling, with a new assignment token', async () => {
  const storage = setup()
  const id = await allocateAppSubdomain(storage, { userPk: 'a', appId: 'app' })
  const token = storage.local_subdomainLifecycle$().assignments[id]
  await releaseAppSubdomain(storage, { userPk: 'a', appId: 'app', subdomain: id })
  assert.deepEqual(storage.local_subdomainLifecycle$().pending, [id])
  assert.deepEqual(storage.session_subdomainFreeIds$(), [])
  await processSubdomainCleanup({ storage, clear: async () => false })
  assert.deepEqual(storage.local_subdomainLifecycle$().pending, [id])
  await processSubdomainCleanup({
    storage, clear: async (origin, options) => {
      assert.equal(origin, id)
      assert.equal(options.strict, true)
      return true
    }
  })
  assert.deepEqual(storage.local_subdomainLifecycle$().pending, [])
  assert.deepEqual(storage.session_subdomainFreeIds$(), [id])
  assert.equal(await allocateAppSubdomain(storage, { userPk: 'b', appId: 'another' }), id)
  assert.notEqual(storage.local_subdomainLifecycle$().assignments[id], token)
})

test('a live origin reservation prevents cleanup until released', async () => {
  const storage = setup()
  const id = await allocateAppSubdomain(storage, { userPk: 'a', appId: 'app' })
  const controller = new AbortController()
  assert.equal(await reserveSubdomainUse(id, { storage, signal: controller.signal, userPk: 'a', appId: 'app' }), true)
  try {
    await retireSubdomainsFor(storage, { userPk: 'a' })
    const clear = mock.fn(async () => true)
    await processSubdomainCleanup({ storage, clear })
    assert.equal(clear.mock.callCount(), 0)
    assert.notEqual(await allocateAppSubdomain(storage, { userPk: 'b', appId: 'app' }), id)
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 0))
    await processSubdomainCleanup({ storage, clear })
    assert.equal(clear.mock.callCount(), 1)
  } finally { controller.abort() }
})

test('legacy free IDs are quarantined and stale counters never overwrite mappings', async () => {
  const storage = setup({
    session_subdomainFreeIds: ['7'], session_subdomainNextId: 0,
    session_subdomainToApp_9: { userPk: 'old', appId: 'old' }
  })
  assert.equal(await allocateAppSubdomain(storage, { userPk: 'new', appId: 'app' }), '10')
  assert.deepEqual(storage.local_subdomainLifecycle$().pending, ['7'])
  assert.deepEqual(storage.session_subdomainToApp_9$(), { userPk: 'old', appId: 'old' })
})

test('concurrent allocations preserve one mapping per pair and separate owners', async () => {
  const storage = setup()
  const ids = await Promise.all(['a', 'a', 'b'].map(userPk => allocateAppSubdomain(storage, { userPk, appId: 'app' })))
  assert.equal(ids[0], ids[1])
  assert.notEqual(ids[0], ids[2])
  assert.equal(await releaseAppSubdomain(storage, { userPk: 'b', appId: 'app', subdomain: ids[0] }), false)
})

test('an interrupted cleanup certificate is quarantined again and unavailable APIs do not recycle', async () => {
  const storage = setup({
    session_subdomainFreeIds: ['7'], local_subdomainLifecycle: { version: 1, pending: ['7'], assignments: { 7: 'old' } }
  })
  await processSubdomainCleanup({ storage, locks: null, clear: () => { throw new Error('must not run') } })
  assert.notEqual(await allocateAppSubdomain(storage, { userPk: 'new', appId: 'app' }), '7')
  await processSubdomainCleanup({ storage, clear: async () => { throw new Error('timeout') } })
  assert.deepEqual(storage.local_subdomainLifecycle$().pending, ['7'])
})

test('cleanup reports committed releases and pending reasons, suppressing unchanged retries', async t => {
  const info = t.mock.method(console, 'info', () => {})
  const warn = t.mock.method(console, 'warn', () => {})
  const storage = setup()
  await processSubdomainCleanup({ storage })
  assert.equal(info.mock.callCount() + warn.mock.callCount(), 0)
  const ids = await Promise.all(['a', 'b', 'c'].map(userPk => allocateAppSubdomain(storage, { userPk, appId: 'app' })))
  for (const userPk of ['a', 'b', 'c']) await retireSubdomainsFor(storage, { userPk })
  const clear = async id => {
    if (id === ids[0]) return true
    if (id === ids[1]) return false
    throw new Error('Data clear timeout')
  }
  await processSubdomainCleanup({ storage, clear })
  assert.equal(warn.mock.callCount(), 1)
  assert.deepEqual(warn.mock.calls[0].arguments, [
    '[subdomain-cleanup] Completed: 1; pending: 2',
    {
      completed: [ids[0]], pending: [
        { id: ids[1], reason: 'Origin cleanup was not confirmed' },
        { id: ids[2], reason: 'Data clear timeout' }
      ]
    }
  ])
  assert.deepEqual(storage.session_subdomainFreeIds$(), [ids[0]])
  await processSubdomainCleanup({ storage, clear })
  assert.equal(warn.mock.callCount(), 1)
  // A changed error is visible even when the pending IDs did not change.
  await processSubdomainCleanup({ storage, clear: async () => { throw new Error('IndexedDB deletion blocked') } })
  assert.equal(warn.mock.callCount(), 2)
  await processSubdomainCleanup({ storage, clear: async () => true })
  assert.deepEqual(info.mock.calls[0].arguments, [
    '[subdomain-cleanup] Completed: 2; pending: 0', { completed: ids.slice(1), pending: [] }
  ])
  await processSubdomainCleanup({ storage })
  assert.equal(info.mock.callCount(), 1)
})

test('cleanup reports unavailable Web Locks, busy origins and mapped pending IDs', async t => {
  const info = t.mock.method(console, 'info', () => {})
  const warn = t.mock.method(console, 'warn', () => {})
  const storage = setup()
  await processSubdomainCleanup({ storage })
  const id = await allocateAppSubdomain(storage, { userPk: 'a', appId: 'app' })
  const controller = new AbortController()
  await reserveSubdomainUse(id, { storage, signal: controller.signal, userPk: 'a', appId: 'app' })
  const clear = t.mock.fn(async () => true)
  try {
    await retireSubdomainsFor(storage, { userPk: 'a' })
    await processSubdomainCleanup({ storage, clear, locks: null })
    await processSubdomainCleanup({ storage, clear, locks: null })
    assert.equal(warn.mock.callCount(), 1)
    assert.deepEqual(warn.mock.calls[0].arguments[1].pending, [
      { id, reason: 'Web Locks unavailable; recycling disabled' }
    ])
    await processSubdomainCleanup({ storage, clear })
    await processSubdomainCleanup({ storage, clear })
    assert.equal(info.mock.callCount(), 1)
    assert.deepEqual(info.mock.calls[0].arguments[1].pending, [
      { id, reason: 'Origin in use or cleanup running in another tab' }
    ])
    assert.equal(clear.mock.callCount(), 0)
  } finally { controller.abort() }
  await new Promise(resolve => setTimeout(resolve, 0))
  storage[`session_subdomainToApp_${id}$`]({ userPk: 'a', appId: 'app' })
  await processSubdomainCleanup({ storage, clear })
  assert.deepEqual(info.mock.calls[1].arguments[1].pending, [{ id, reason: 'Origin still mapped' }])
  assert.equal(clear.mock.callCount(), 0)
})

test('cleanup does not report a successful clear as completed if the origin was mapped meanwhile', async t => {
  const info = t.mock.method(console, 'info', () => {})
  t.mock.method(console, 'warn', () => {})
  const storage = setup()
  await processSubdomainCleanup({ storage })
  const id = await allocateAppSubdomain(storage, { userPk: 'a', appId: 'app' })
  await retireSubdomainsFor(storage, { userPk: 'a' })
  await processSubdomainCleanup({
    storage,
    clear: async () => {
      storage[`session_subdomainToApp_${id}$`]({ userPk: 'b', appId: 'app' })
      return true
    }
  })
  assert.deepEqual(info.mock.calls[0].arguments, [
    '[subdomain-cleanup] Completed: 0; pending: 1',
    { completed: [], pending: [{ id, reason: 'Origin mapping changed during cleanup' }] }
  ])
  assert.deepEqual(storage.session_subdomainFreeIds$(), [])
})

test('background maintenance queues interrupted assignments and advances the counter even when cleanup fails', async () => {
  const storage = setup({
    session_subdomainNextId: 0,
    local_subdomainLifecycle: { version: 1, pending: [], assignments: { 7: 'interrupted' } }
  })
  const clear = mock.fn(async () => false)
  await processSubdomainCleanup({ storage, clear })
  assert.equal(clear.mock.callCount(), 1)
  assert.equal(clear.mock.calls[0].arguments[0], '7')
  assert.equal(storage.session_subdomainNextId$(), 8)
  assert.deepEqual(storage.local_subdomainLifecycle$().pending, ['7'])
  assert.deepEqual(storage.session_subdomainFreeIds$() ?? [], [])
})

test('maintenance preserves an assignment with a forward-only mapping and never cleans it', async () => {
  const storage = setup({
    session_subdomainByUserAndApp_user_app: '7',
    local_subdomainLifecycle: { version: 1, pending: [], assignments: { 7: 'partial' } }
  })
  const clear = mock.fn(async () => true)
  await processSubdomainCleanup({ storage, clear })
  assert.equal(clear.mock.callCount(), 0)
  assert.equal(storage.session_subdomainNextId$(), 8)
  assert.deepEqual(storage.local_subdomainLifecycle$().pending, [])
  assert.equal(storage.session_subdomainByUserAndApp_user_app$(), '7')
})
