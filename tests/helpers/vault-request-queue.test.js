import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { classifyVaultRequest, createVaultRequestQueue } from '../../src/services/vault-request-queue.js'
const request = (kind, id = String(kind)) => ({ code: 'NIP07', id, payload: { method: 'signEvent', params: [{ kind, tags: [] }] } })
function fixture () {
  const sent = []
  const queue = createVaultRequestQueue({ send: (port, msg, options) => { const gate = Promise.withResolvers(); sent.push({ port, msg, options, ...gate }); return gate.promise } })
  return { queue, sent }
}

test('classifies crypto, personal copies, obfuscation and explicit chunks without scope rules', () => {
  for (const kind of [9, 1063, 3560, 26300, 26400, 34601]) {
    assert.equal(classifyVaultRequest(request(kind)).priority, true)
    for (const method of ['nip44v3_encrypt', 'nip44v3_decrypt', 'nip44v3_encrypt_double_dh', 'nip44v3_decrypt_double_dh', 'obfuscate']) {
      assert.equal(classifyVaultRequest({ code: 'NIP07', payload: { method, params: ['x', String(kind), 'arbitrary-scope'] } }).priority, true)
    }
  }
  assert.equal(classifyVaultRequest({ code: 'NIP07', payload: { method: 'obfuscate', params: ['x', '1006', '.id'] } }).priority, true)
  const wrapped = request(1006); wrapped.payload.params[0].tags = [['k', '9']]
  assert.equal(classifyVaultRequest(wrapped).priority, true)
  const chunk = request(26300); chunk.payload.params[0].tags = [['i', '0']]
  assert.equal(classifyVaultRequest(chunk).chunk, true)
  assert.equal(classifyVaultRequest(request(3)).priority, false)
  assert.equal(classifyVaultRequest({ code: 'NIP07', payload: { method: 'signEvent', params: [{ kind: 1006, tags: {} }] } }).priority, false)
  assert.equal(classifyVaultRequest({ code: 'NIP07', payload: { method: 'nip44v3_encrypt', params: null } }).priority, false)
  assert.equal(classifyVaultRequest({ code: 'NIP07', payload: { method: 'nip44v3_encrypt', params: ['x', 'garbage'] } }).priority, false)
})

test('dispatches the exact queued jobs when several slots become available', async () => {
  const { queue, sent } = fixture()
  const pending = Array.from({ length: 9 }, (_, id) => queue.ask(request(9, id)))
  queue.setPort({})
  assert.deepEqual(sent.map(v => v.msg.id), [0, 1, 2, 3, 4])
  sent.slice(0, 3).forEach(v => v.resolve({ payload: true }))
  await tick()
  assert.deepEqual(sent.map(v => v.msg.id), [0, 1, 2, 3, 4, 5, 6, 7])
  queue.close(); await Promise.all(pending)
})

test('reserves an interactive slot and bypasses chunks at their concurrency ceiling', async () => {
  const { queue, sent } = fixture(); queue.setPort({})
  const normal = Array.from({ length: 5 }, (_, id) => queue.ask(request(3, id)))
  assert.equal(sent.length, 4)
  const urgent = queue.ask(request(9, 'urgent'))
  assert.equal(sent.at(-1).msg.id, 'urgent')
  queue.close(); await Promise.all([...normal, urgent])
  const f = fixture()
  const chunks = [0, 1, 2].map(id => f.queue.ask(request(34601, id)))
  const text = f.queue.ask(request(9, 'text'))
  f.queue.setPort({})
  assert.deepEqual(f.sent.map(v => v.msg.id), [0, 1, 'text'])
  f.queue.close(); await Promise.all([...chunks, text])
})

test('serves normal work after three priority dispatches', async () => {
  const { queue, sent } = fixture()
  const pending = [...Array.from({ length: 6 }, (_, id) => queue.ask(request(9, id))), queue.ask(request(3, 'normal'))]
  queue.setPort({})
  assert.deepEqual(sent.slice(0, 4).map(v => v.msg.id), [0, 1, 2, 'normal'])
  queue.close(); await Promise.all(pending)
})

test('times out while disconnected and ignores old-port completions', async () => {
  const { queue, sent } = fixture()
  const expired = await queue.ask(request(9), { timeout: 5 })
  assert.match(expired.error.message, /timed out/)
  queue.setPort({})
  assert.equal(sent.length, 0)
  const old = queue.ask(request(9, 'old'))
  queue.setPort(null)
  assert.match((await old).error.message, /connection changed/)
  const next = queue.ask(request(9, 'next'))
  queue.setPort({})
  sent[0].resolve({ payload: 'late' }); await tick()
  assert.equal(queue.snapshot().running, 1)
  sent[1].resolve({ payload: 'current' })
  assert.equal((await next).payload, 'current')
  queue.close()
})

test('sync failures, rejected transports and early denials release slots exactly once', async () => {
  let calls = 0
  const queue = createVaultRequestQueue({ send: () => { if (++calls === 1) throw Error('sync'); return Promise.reject(Error('async')) } })
  queue.setPort({})
  assert.match((await queue.ask(request(9))).error.message, /sync/)
  assert.match((await queue.ask(request(9))).error.message, /async/)
  assert.equal(queue.snapshot().running, 0)
  queue.close()
})

test('an early denial cannot strand the next request, and instant control calls retain their bypass', async () => {
  const sent = []; let checked = 0
  const queue = createVaultRequestQueue({
    beforeSend: msg => { checked++; return msg.id === 'blocked' ? { error: Error('denied') } : undefined },
    send: async (port, msg) => { sent.push(msg.id); return { payload: true } }
  })
  queue.setPort({})
  assert.match((await queue.ask(request(9, 'blocked'))).error.message, /denied/)
  assert.equal((await queue.ask(request(9, 'next'))).payload, true)
  assert.equal((await queue.ask(request(9, 'control'), { instant: true })).payload, true)
  assert.equal(checked, 2)
  assert.deepEqual(sent, ['next', 'control'])
  assert.equal(queue.snapshot().running, 0)
  queue.close()
})
