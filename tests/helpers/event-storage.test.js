import { it } from 'node:test'
import assert from 'node:assert/strict'
import { parseQuotaMiB, quotaDraft, draftOverrides, occupancy, usageSegments } from '#views/event-storage/model.js'
import { eventStorageLocales } from '#views/event-storage/locales.js'

it('validates MiB drafts and preserves unedited byte limits', () => {
  for (const invalid of ['', ' ', '-1', 'Infinity', 'NaN', '1e309', '9007199254740991', '1x']) assert.equal(parseQuotaMiB(invalid), null)
  assert.equal(parseQuotaMiB('0'), 0)
  assert.equal(parseQuotaMiB('.5'), 524288)
  assert.equal(parseQuotaMiB('0.000001'), 1)
  const limits = { publicBytes: Number.MAX_SAFE_INTEGER, cacheBytes: 134217728, privateBytes: 1 }
  assert.deepEqual(draftOverrides(quotaDraft(limits), {}), {})
  assert.deepEqual(draftOverrides({ ...quotaDraft(limits), cacheBytes: '64.5' }, { cacheBytes: true }), { cacheBytes: 67633152 })
})
it('avoids double counting in the donut and handles exceeded and zero bars', () => {
  assert.deepEqual(usageSegments({ publicBytes: 100, cacheBytes: 40, privateBytes: 200 }), [60, 40, 200])
  assert.equal(occupancy(20, 10), 100)
  assert.equal(occupancy(20, 0), 100)
  assert.equal(occupancy(0, 0), 0)
})
it('provides every storage message in all supported locales', () => {
  for (const [key, translations] of Object.entries(eventStorageLocales)) {
    assert.equal(translations.en, key)
    assert.equal(Object.keys(translations).length, 11)
    assert.ok(Object.values(translations).every(value => typeof value === 'string' && value.length))
  }
})
