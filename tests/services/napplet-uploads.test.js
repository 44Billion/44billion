import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createHash } from 'node:crypto'
import { createNappletUploadService, normalizeUploadServers, MAX_UPLOAD_BYTES } from '#services/napplets/uploads.js'

const pubkey = 'ab'.repeat(32)
function fixture (options = {}) {
  const messages = []
  const controller = new AbortController()
  let finish
  const done = new Promise(resolve => { finish = resolve })
  const service = createNappletUploadService({
    account: { guard () {}, getPublicKey: () => pubkey, signEvent: async template => ({ ...template, pubkey, id: 'id', sig: 'sig' }) },
    signal: controller.signal,
    latest: async () => ({ tags: [['server', 'https://one.example'], ['server', 'https://two.example']] }),
    confirm: async ({ servers }) => servers,
    ...options
  })
  const send = message => { messages.push(message); if (['complete', 'failed', 'cancelled'].includes(message.status?.status)) finish(message.status) }
  return { service, messages, controller, done, request: request => service.handleMessage('window', { type: 'upload.upload', id: 'request', request }, send), send }
}

it('normalizes public destinations without accepting local servers, credentials or query tokens', () => {
  assert.deepEqual(normalizeUploadServers(['https://one.example/', 'https://one.example', 'http://one.example', 'https://localhost', 'https://user:secret@one.example', 'https://one.example/?token=secret']), ['https://one.example'])
})

it('returns pending before consent and uploads to preferred mirrors with validated integrity', async () => {
  const calls = []
  const data = new Blob(['test'])
  const hash = createHash('sha256').update('test').digest('hex')
  const f = fixture({
    fetchUpload: async (url, init) => {
      calls.push(url)
      assert.equal(init.credentials, 'omit')
      assert.equal(init.redirect, 'error')
      assert.equal(init.method, 'PUT')
      return Response.json({ url: `${new URL(url).origin}/${hash}`, sha256: hash, size: 4, type: 'text/plain' })
    }
  })
  f.request({ data, filename: 'test.txt' })
  assert.equal(f.messages[0].result.status, 'pending')
  const status = await f.done
  assert.equal(status.status, 'complete', status.error)
  assert.deepEqual(calls, ['https://one.example/upload', 'https://two.example/upload'])
  assert.deepEqual(status.fallbackUrls, [`https://two.example/${hash}`])
  f.controller.abort()
})

it('retains a successful mirror when another server is unavailable', async () => {
  const hash = createHash('sha256').update('test').digest('hex')
  const f = fixture({
    fetchUpload: async url => {
      if (url.includes('one.example')) throw new Error('offline')
      return Response.json({ url: `https://two.example/${hash}`, sha256: hash, size: 4 })
    }
  })
  f.request({ data: new Blob(['test']) })
  const status = await f.done
  assert.equal(status.status, 'complete', status.error)
  f.controller.abort()
})

it('rejects corrupt descriptors and cancels consent without signing or sending data', async () => {
  const f = fixture({ fetchUpload: async () => Response.json({ url: 'https://one.example/file', sha256: 'wrong', size: 4 }) })
  f.request({ data: new Blob(['test']) })
  assert.equal((await f.done).status, 'failed')
  f.controller.abort()
  const cancelled = fixture({ confirm: async () => undefined, fetchUpload: () => assert.fail('must not upload') })
  cancelled.request({ data: new Blob(['test']) })
  assert.equal((await cancelled.done).status, 'cancelled')
  cancelled.controller.abort()
})

it('rejects unsupported rails and large data before consent; scopes status to its instance', () => {
  const f = fixture({ confirm: () => assert.fail('must not prompt') })
  f.request({ rail: 'nip96', data: new Blob(['test']) })
  assert.equal(f.messages.at(-1).error, 'UNSUPPORTED_UPLOAD_RAIL')
  f.request({ data: new Blob([new Uint8Array(MAX_UPLOAD_BYTES + 1)]) })
  assert.equal(f.messages.at(-1).error, 'UPLOAD_TOO_LARGE')
  f.service.handleMessage('window', { type: 'upload.status', id: 'status', uploadId: 'foreign' }, f.send)
  assert.equal(f.messages.at(-1).error, 'UNKNOWN_UPLOAD')
  f.controller.abort()
})

it('rechecks account access after consent and after signing before sending bytes', async () => {
  let allowed = true
  let sends = 0
  const account = { guard () { if (!allowed) throw new Error('REVOKED') }, getPublicKey: () => pubkey, signEvent: async template => ({ ...template, pubkey }) }
  const f = fixture({ account, confirm: async ({ servers }) => { allowed = false; return servers }, fetchUpload: async () => { sends++; return new Response() } })
  f.request({ data: new Blob(['test']) })
  assert.equal((await f.done).error, 'REVOKED')
  assert.equal(sends, 0)
  f.controller.abort()
  allowed = true
  const afterSign = fixture({ account: { ...account, signEvent: async template => { allowed = false; return { ...template, pubkey } } }, fetchUpload: async () => { sends++; return new Response() } })
  afterSign.request({ data: new Blob(['test']) })
  assert.equal((await afterSign.done).error, 'REVOKED')
  assert.equal(sends, 0)
  afterSign.controller.abort()
})

it('cancels the transport on teardown and suppresses late responses', async () => {
  let started
  const start = new Promise(resolve => { started = resolve })
  let aborted = false
  const f = fixture({
    fetchUpload: async (_url, { signal }) => {
      started()
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true }))
    }
  })
  f.request({ data: new Blob(['test']) })
  await start
  const count = f.messages.length
  f.controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(aborted, true)
  assert.equal(f.messages.length, count)
})
