import assert from 'node:assert/strict'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { installUploadBinding } from '#services/napplets/upload-binding.js'

function binding (start) {
  const handlers = new Set()
  const events = new Map()
  const api = { upload: start, onStatus: handler => { handlers.add(handler); return { close: () => handlers.delete(handler) } } }
  runInNewContext(`(${installUploadBinding.toString()})()`, { window: { napplet: { upload: api }, addEventListener: (name, handler) => events.set(name, handler), removeEventListener: name => events.delete(name) }, setTimeout, clearTimeout })
  return { api, handlers, events, emit: status => { for (const handler of handlers) handler(status) } }
}

it('waits through pending and uploading until a URL exists, ignoring unrelated jobs', async () => {
  const f = binding(async () => ({ ok: true, uploadId: 'one', status: 'pending' }))
  let settled = false
  const promise = f.api.uploadAndWait({}).then(result => { settled = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  f.emit({ uploadId: 'other', status: 'complete', url: 'wrong' })
  f.emit({ uploadId: 'one', status: 'uploading' })
  assert.equal(settled, false)
  f.emit({ ok: true, uploadId: 'one', status: 'complete', url: 'https://media.example/file' })
  assert.equal((await promise).url, 'https://media.example/file')
  assert.equal(f.handlers.size, 0)
})

it('captures completion arriving before the pending reply resolves', async () => {
  const f = binding(async () => {
    f.emit({ ok: true, uploadId: 'one', status: 'complete', url: 'https://media.example/file' })
    return { ok: true, uploadId: 'one', status: 'pending' }
  })
  assert.equal((await f.api.uploadAndWait({})).status, 'complete')
  assert.equal(f.handlers.size, 0)
})

it('returns terminal failures and cleans up listeners on rejected requests', async () => {
  const f = binding(async () => ({ ok: false, uploadId: 'one', status: 'failed', error: 'denied' }))
  assert.equal((await f.api.uploadAndWait({})).error, 'denied')
  assert.equal(f.handlers.size, 0)
  const rejected = binding(async () => { throw new Error('REVOKED') })
  await assert.rejects(rejected.api.uploadAndWait({}), /REVOKED/)
  assert.equal(rejected.handlers.size, 0)
})

it('preserves the standard initial-result upload method', async () => {
  const start = async () => ({ ok: true, uploadId: 'one', status: 'uploading' })
  const f = binding(start)
  assert.equal(f.api.upload, start)
  assert.equal((await f.api.upload({})).status, 'uploading')
  assert.equal(f.handlers.size, 0)
})

it('closes terminal-wait subscriptions when the document is torn down', async () => {
  const f = binding(async () => ({ ok: true, uploadId: 'one', status: 'uploading' }))
  const result = f.api.uploadAndWait({})
  f.events.get('pagehide')()
  await assert.rejects(result, /UPLOAD_CONTEXT_CLOSED/)
  assert.equal(f.handlers.size, 0)
  assert.equal(f.events.size, 0)
})
