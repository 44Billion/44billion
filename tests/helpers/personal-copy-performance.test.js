import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preparePersonalCopyUnsignedEvent } from '#helpers/personal-copy.js'
import { cachedPersonalCopyObfuscation, cachedPersonalCopyObfuscations, clearPersonalCopyCache } from '#services/personal-copy-cache.js'

const owner = 'a'.repeat(64)
test('personal-copy independent operations overlap at most four and preserve mirror order', async () => {
  let active = 0; let peak = 0
  const pending = []
  const operation = value => new Promise(resolve => {
    active++; peak = Math.max(peak, active)
    pending.push(() => { active--; resolve(value) })
  })
  const inner = { kind: 9, created_at: 1, content: 'body', tags: Array.from({ length: 8 }, (_, i) => ['q', String(i)]) }
  const work = preparePersonalCopyUnsignedEvent({ originalEvent: inner, ownerPubkey: owner, context: 'dm', encrypt: () => operation('ciphertext'), obfuscate: (value, kind, scope) => operation(`${scope}:${value}`) })
  for (let index = 0; index < 30; index++) { await new Promise(resolve => setImmediate(resolve)); pending.shift()?.() }
  const result = await work
  assert.equal(peak, 4)
  assert.equal(active, 0)
  assert.deepEqual(result.event.tags.slice(3, 11), inner.tags.map(tag => ['o', `#q:${tag[1]}`]))
  assert.equal(result.event.tags[1][1], ':dm')
  assert.equal(result.event.content, 'ciphertext')
  assert.deepEqual(result.event.tags.at(-1), ['imkc'])
})

test('personal copies batch mirror and coordinate obfuscations into two vault requests', async () => {
  const batches = []
  let encryptions = 0
  const inner = { kind: 30078, created_at: 1, content: '', tags: [['d', 'seed'], ['t', 'topic'], ['c', 'owner']] }
  const result = await preparePersonalCopyUnsignedEvent({
    originalEvent: inner,
    ownerPubkey: owner,
    context: 'dm',
    encrypt: async () => { encryptions++; return 'ciphertext' },
    obfuscate: async () => assert.fail('individual obfuscation should not run'),
    obfuscateMany: async operations => {
      batches.push(operations)
      return operations.map(operation => `${operation.scope}:${operation.value}`)
    }
  })
  assert.equal(encryptions, 1)
  assert.equal(batches.length, 2)
  assert.equal(batches[0].length, 6)
  assert.deepEqual(batches[1].map(operation => operation.scope), ['.coordinate'])
  assert.equal(result.event.content, 'ciphertext')
  assert.equal(result.event.tags.filter(tag => tag[0] === 'o').length, 5)
})

test('stable obfuscation reuse is isolated, bounded, expires and fences stale connections', async t => {
  clearPersonalCopyCache(); t.after(clearPersonalCopyCache)
  let now = 0
  t.mock.method(performance, 'now', () => now)
  let calls = 0
  const query = (account, value, scope = '') => cachedPersonalCopyObfuscation(account, value, '1006', scope, async () => ++calls)
  assert.equal(await query(owner, 'context'), 1)
  assert.equal(await query(owner, 'context'), 1)
  await query('b', 'context'); await query(owner, 'context', '.pubkey')
  assert.equal(calls, 3)
  await query(owner, 'id', '.id'); await query(owner, 'id', '.id')
  assert.equal(calls, 5)
  for (let i = 0; i < 64; i++) await query(owner, `context${i}`)
  await query(owner, 'context'); assert.equal(calls, 70)
  now = 60000
  await query(owner, 'context'); assert.equal(calls, 71)
  const gate = Promise.withResolvers()
  const stale = cachedPersonalCopyObfuscation(owner, 'stale', '1006', '', () => gate.promise)
  clearPersonalCopyCache(); gate.resolve('stale-result'); await stale
  assert.notEqual(await query(owner, 'stale'), 'stale-result')
})

test('batched personal-copy obfuscation preserves order, deduplicates and caches stable values', async t => {
  clearPersonalCopyCache(); t.after(clearPersonalCopyCache)
  let calls = 0
  const operations = [
    { value: 'topic', kind: '1006', scope: '#t' },
    { value: owner, kind: '1006', scope: '.pubkey' },
    { value: 'topic', kind: '1006', scope: '#t' },
    { value: 'context', kind: '1006', scope: '' }
  ]
  const batch = async pending => {
    calls++
    assert.deepEqual(pending.map(operation => [operation.scope, operation.value]), [['#t', 'topic'], ['.pubkey', owner], ['', 'context']])
    return pending.map(operation => `${operation.scope}:${operation.value}`)
  }
  assert.deepEqual(await cachedPersonalCopyObfuscations(owner, operations, batch), [
    '#t:topic', `.pubkey:${owner}`, '#t:topic', ':context'
  ])
  assert.equal(calls, 1)
  assert.deepEqual(await cachedPersonalCopyObfuscations(owner, operations.slice(1, 2), batch), [`.pubkey:${owner}`])
  assert.equal(calls, 1)
  assert.deepEqual(await cachedPersonalCopyObfuscations(owner, operations.slice(0, 1), async pending => {
    calls++
    return pending.map(operation => `${operation.scope}:${operation.value}`)
  }), ['#t:topic'])
  assert.equal(calls, 2)
})
