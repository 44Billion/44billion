import assert from 'node:assert/strict'
import { it } from 'node:test'
import { setWebStorageItem } from '../../node_modules/thenameisf/shared/helpers/web-storage.js'
import {
  installLocalStoragePressureRelief,
  uninstallLocalStoragePressureRelief
} from '#helpers/local-storage-pressure-relief.js'

class FakeStorage {
  constructor (values = {}) {
    this.values = new Map(Object.entries(values))
    this.quotaKeys = new Set()
    this.removeError = null
    this.alwaysQuota = false
  }

  get length () {
    return this.values.size
  }

  key (index) {
    return [...this.values.keys()][index] ?? null
  }

  getItem (key) {
    return this.values.get(key) ?? null
  }

  setItem (key, value) {
    if (this.alwaysQuota || [...this.quotaKeys].some(blocked => this.values.has(blocked))) throw quotaError()
    this.values.set(key, String(value))
  }

  removeItem (key) {
    if (this.removeError) throw this.removeError
    this.values.delete(key)
  }
}

function quotaError () {
  return Object.assign(new Error('storage quota exceeded'), { name: 'QuotaExceededError' })
}

function fixture (values) {
  const local = new FakeStorage(values)
  const session = new FakeStorage()
  const eventTarget = new EventTarget()
  const events = []
  eventTarget.addEventListener('storage', event => events.push(event))
  class TestStorageEvent extends Event {
    constructor (type, init) {
      super(type)
      Object.assign(this, init)
    }
  }
  const install = () => installLocalStoragePressureRelief({
    storage: local,
    prototype: FakeStorage.prototype,
    StorageEventClass: TestStorageEvent,
    location: { href: 'https://44billion.test/' },
    eventTarget
  })
  return { local, session, events, install }
}

it('relieves quota errors from direct localStorage and setWebStorageItem writes', async t => {
  const item = fixture({
    session_appById_a_icon: '"icon"',
    session_appById_a_name: '"name"'
  })
  item.local.quotaKeys.add('session_appById_a_icon')
  t.after(() => uninstallLocalStoragePressureRelief())
  item.install()

  item.local.setItem('direct', 'ok')
  assert.equal(item.local.getItem('direct'), 'ok')
  assert.equal(item.local.getItem('session_appById_a_icon'), null)

  item.local.quotaKeys.add('session_appById_a_name')
  setWebStorageItem(item.local, 'wrapped', { ok: true })
  assert.equal(item.local.getItem('wrapped'), '{"ok":true}')
  assert.equal(item.local.getItem('session_appById_a_name'), null)
  assert.deepEqual(item.events.map(event => event.key).sort(), [
    'session_appById_a_icon',
    'session_appById_a_name'
  ])
})

it('never applies relief to sessionStorage or removes protected keys', t => {
  const item = fixture({
    session_appById_a_icon: '"small"',
    session_appById_b_icon: `"${'x'.repeat(20)}"`,
    session_appById_a_description: '"description"',
    session_appById_a_relayHints: '"relay"',
    session_appById_a_name: '"name"',
    session_workspaceKeys: '["ws"]',
    session_appById_a_customCache: '"protected-unknown"'
  })
  item.local.quotaKeys.add('session_appById_a_icon')
  item.session.alwaysQuota = true
  t.after(() => uninstallLocalStoragePressureRelief())
  item.install()

  assert.throws(() => item.session.setItem('session-only', 'v'), { name: 'QuotaExceededError' })
  assert.equal(item.local.length, 7)

  item.local.setItem('result', 'ok')
  const remaining = [...item.local.values.keys()]
  assert.ok(!remaining.includes('session_appById_a_icon'))
  assert.ok(!remaining.includes('session_appById_b_icon'))
  for (const key of ['session_workspaceKeys', 'session_appById_a_customCache']) {
    assert.ok(remaining.includes(key), key)
  }
})

it('orders removals by metadata type before value size', t => {
  const values = {
    session_appById_a_name: '"n"',
    session_appById_a_relayHints: '"r"',
    session_appById_a_description: '"d"',
    session_appById_b_icon: '"s"',
    session_appById_a_icon: '"large"'
  }
  const item = fixture(values)
  for (const key of [...item.local.values.keys()]) item.local.quotaKeys.add(key)
  t.after(() => uninstallLocalStoragePressureRelief())
  item.install()
  item.local.setItem('result', 'ok')

  assert.deepEqual(item.events.slice(0, 5).map(event => event.key), [
    'session_appById_a_icon',
    'session_appById_b_icon',
    'session_appById_a_description',
    'session_appById_a_relayHints',
    'session_appById_a_name'
  ])
})

it('bounds each round to ten keys and permits at most three rounds', t => {
  const values = {}
  for (let index = 0; index < 31; index++) {
    values[`session_appById_a${index}_icon`] = `"${index}"`
  }
  const item = fixture(values)
  for (const key of Object.keys(values)) item.local.quotaKeys.add(key)
  t.after(() => uninstallLocalStoragePressureRelief())
  item.install()

  assert.throws(() => item.local.setItem('result', 'ok'), { name: 'QuotaExceededError' })
  assert.equal(item.local.values.has('result'), false)
  assert.equal(item.events.length, 30)
  assert.equal(item.local.length, 1)
})

it('bounds a round to 64 KiB except when one oversized value is required', t => {
  const value = `"${'x'.repeat(40 * 1024)}"`
  const values = {
    session_appById_a_icon: value,
    session_appById_b_icon: value,
    session_appById_c_icon: value
  }
  const item = fixture(values)
  for (const key of Object.keys(values)) item.local.quotaKeys.add(key)
  t.after(() => uninstallLocalStoragePressureRelief())
  item.install()

  item.local.setItem('result', 'ok')
  assert.deepEqual(item.events.map(event => event.key), Object.keys(values))
})

it('preserves the quota error and current write when cleanup cannot progress', t => {
  const item = fixture({ session_appById_a_icon: '"icon"' })
  item.local.quotaKeys.add('session_appById_a_icon')
  item.local.removeError = new Error('remove failed')
  t.after(() => uninstallLocalStoragePressureRelief())
  item.install()

  assert.throws(() => item.local.setItem('result', 'ok'), error => {
    assert.equal(error.name, 'QuotaExceededError')
    assert.equal(error.message, 'storage quota exceeded')
    return true
  })
  assert.equal(item.local.getItem('result'), null)
})

it('installs once and restores the original prototype on uninstall', t => {
  const item = fixture({ session_appById_a_icon: '"icon"' })
  item.local.quotaKeys.add('session_appById_a_icon')
  const original = FakeStorage.prototype.setItem
  const first = item.install()
  const second = item.install()
  t.after(() => uninstallLocalStoragePressureRelief())
  assert.equal(first, second)
  assert.notEqual(FakeStorage.prototype.setItem, original)
  first()
  assert.equal(FakeStorage.prototype.setItem, original)
})
