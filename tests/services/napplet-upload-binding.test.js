import assert from 'node:assert/strict'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { installUploadBinding } from '#services/napplets/upload-binding.js'

function binding (start) {
  const handlers = new Set()
  const api = { upload: start, onStatus: handler => { handlers.add(handler); return { close: () => handlers.delete(handler) } } }
  runInNewContext(`(${installUploadBinding.toString()})()`, { window: { napplet: { upload: api } }, setTimeout, clearTimeout })
  return { api, handlers, emit: status => { for (const handler of handlers) handler(status) } }
}

it('waits through pending and uploading until a URL exists, ignoring unrelated jobs', async () => {
  const f = binding(async () => ({ ok: true, uploadId: 'one', status: 'pending' }))
  let settled = false
  const promise = f.api.upload({}).then(result => { settled = true; return result })
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
  assert.equal((await f.api.upload({})).status, 'complete')
  assert.equal(f.handlers.size, 0)
})

it('returns terminal failures and cleans up listeners on rejected requests', async () => {
  const f = binding(async () => ({ ok: false, uploadId: 'one', status: 'failed', error: 'denied' }))
  assert.equal((await f.api.upload({})).error, 'denied')
  assert.equal(f.handlers.size, 0)
  const rejected = binding(async () => { throw new Error('REVOKED') })
  await assert.rejects(rejected.api.upload({}), /REVOKED/)
  assert.equal(rejected.handlers.size, 0)
})
