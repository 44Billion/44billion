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

it('returns uploading before consent and uploads to preferred mirrors with validated integrity', async () => {
  const calls = []
  const authorizations = []
  let signs = 0
  const data = new Blob(['test'])
  const hash = createHash('sha256').update('test').digest('hex')
  const f = fixture({
    account: { guard () {}, getPublicKey: () => pubkey, signEvent: async template => { signs++; return { ...template, pubkey, id: 'id', sig: 'sig' } } },
    fetchUpload: async (url, init) => {
      calls.push(url)
      authorizations.push(init.headers.Authorization)
      if (url.endsWith('/mirror')) { assert.equal(init.headers['Content-Type'], 'application/json'); assert.equal(JSON.parse(init.body).url, `https://one.example/${hash}`) }
      assert.equal(init.credentials, 'omit')
      assert.equal(init.redirect, 'error')
      assert.equal(init.method, 'PUT')
      return Response.json({ url: `${new URL(url).origin}/${hash}`, sha256: hash, size: 4, type: 'text/plain' })
    }
  })
  f.request({ data, filename: 'test.txt' })
  assert.equal(f.messages[0].result.status, 'uploading')
  const status = await f.done
  assert.equal(status.status, 'complete', status.error)
  assert.deepEqual(calls, ['https://one.example/upload', 'https://two.example/mirror'])
  assert.equal(signs, 1)
  assert.equal(authorizations[0], authorizations[1])
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

it('allows a user-selected server when preferred-server discovery fails', async () => {
  const hash = createHash('sha256').update('test').digest('hex')
  let prompted = false
  const f = fixture({
    latest: async () => { throw new Error('INCOMPLETE_PUBLIC_STATE') },
    confirm: async ({ servers }) => { prompted = true; assert.deepEqual(servers, []); return ['https://chosen.example'] },
    fetchUpload: async url => {
      assert.equal(url, 'https://chosen.example/upload')
      return Response.json({ url: `https://chosen.example/${hash}`, sha256: hash, size: 4 })
    }
  })
  f.request({ data: new Blob(['test']) })
  assert.equal((await f.done).status, 'complete')
  assert.equal(prompted, true)
  f.controller.abort()
})

it('does not show destination selection when access is revoked during failed discovery', async () => {
  let allowed = true
  const f = fixture({
    account: { guard () { if (!allowed) throw new Error('REVOKED') }, getPublicKey: () => pubkey },
    latest: async () => { allowed = false; throw new Error('GET_EVENTS_TIMEOUT') },
    confirm: () => assert.fail('revoked access must not open a dialog')
  })
  f.request({ data: new Blob(['test']) })
  assert.equal((await f.done).error, 'REVOKED')
  f.controller.abort()
})

it('falls back from unsupported mirroring to direct upload with the same authorization', async () => {
  const hash = createHash('sha256').update('test').digest('hex')
  const calls = []
  const auth = []
  let signs = 0
  const f = fixture({
    account: { guard () {}, getPublicKey: () => pubkey, signEvent: async template => { signs++; return { ...template, pubkey } } },
    fetchUpload: async (url, init) => {
      calls.push(url)
      auth.push(init.headers.Authorization)
      if (url.endsWith('/mirror')) return new Response('', { status: 405 })
      assert.ok(init.body instanceof ArrayBuffer)
      return Response.json({ url: `${new URL(url).origin}/${hash}`, sha256: hash, size: 4 })
    }
  })
  f.request({ data: new Blob(['test']) })
  assert.equal((await f.done).status, 'complete')
  assert.deepEqual(calls, ['https://one.example/upload', 'https://two.example/mirror', 'https://two.example/upload'])
  assert.equal(new Set(auth).size, 1)
  assert.equal(signs, 1)
  f.controller.abort()
})

it('keeps the original upload successful when every subsequent mirror fails', async () => {
  const hash = createHash('sha256').update('test').digest('hex')
  const f = fixture({
    fetchUpload: async url => {
      if (url.includes('two.example')) throw new Error('offline')
      return Response.json({ url: `https://one.example/${hash}`, sha256: hash, size: 4 })
    }
  })
  f.request({ data: new Blob(['test']) })
  const status = await f.done
  assert.equal(status.status, 'complete')
  assert.equal(status.ok, true)
  assert.equal(status.url, `https://one.example/${hash}`)
  assert.deepEqual(status.fallbackUrls, [])
  f.controller.abort()
})

it('fails an upload only when no destination stores a valid blob', async () => {
  const f = fixture({ fetchUpload: async () => { throw new Error('offline') } })
  f.request({ data: new Blob(['test']) })
  assert.equal((await f.done).ok, false)
  assert.equal(f.messages.at(-1).status.status, 'failed')
  f.controller.abort()
})

for (const outcome of ['deadline', 'cancel', 'revoke']) {
  it(`handles ${outcome} after a verified destination`, async () => {
    const deadline = new AbortController()
    const hash = createHash('sha256').update('test').digest('hex')
    let allowed = true
    let cancel
    const f = fixture({
      present: (_status, action) => { cancel = action },
      deadlineSignal: () => deadline.signal,
      account: { guard () { if (!allowed) throw new Error('REVOKED') }, getPublicKey: () => pubkey, signEvent: async template => ({ ...template, pubkey }) },
      fetchUpload: async url => {
        if (url.includes('one.example')) return Response.json({ url: `https://one.example/${hash}`, sha256: hash, size: 4 })
        if (outcome === 'cancel') cancel()
        if (outcome === 'revoke') allowed = false
        deadline.abort(new DOMException('Deadline', 'TimeoutError'))
        throw deadline.signal.reason
      }
    })
    f.request({ data: new Blob(['test']) })
    const result = await f.done
    assert.equal(result.status, outcome === 'deadline' ? 'complete' : outcome === 'cancel' ? 'cancelled' : 'failed')
    if (outcome === 'deadline') assert.equal(result.url, `https://one.example/${hash}`)
    if (outcome === 'revoke') assert.equal(result.error, 'REVOKED')
    f.controller.abort()
  })
}
