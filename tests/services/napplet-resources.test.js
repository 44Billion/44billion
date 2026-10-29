import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createHash } from 'node:crypto'
import { createResourceService } from '@kehto/services'
import { createNappletResourceResolver, parseBlossomResource, MAX_RESOURCE_BYTES } from '#services/napplets/resources.js'

const content = 'verified resource'
const hash = createHash('sha256').update(content).digest('hex')
const author = 'ab'.repeat(32)

it('parses BUD-10 extensions, repeated hints and extensionless references; rejects the incorrect hash prefix', () => {
  assert.equal(parseBlossomResource(`blossom:${hash}`).hash, hash)
  assert.deepEqual(parseBlossomResource(`blossom:${hash}.png?xs=one.example&xs=two.example&as=${author}&sz=17`), {
    hash, extension: 'png', servers: ['one.example', 'two.example'], authors: [author], size: 17
  })
  for (const value of [`sha256:${hash}`, `//${hash}`, `${hash}/file`, `${hash}.png#fragment`, `${hash}.png?sz=-1`, `${hash}.png?sz=1&sz=2`]) {
    assert.throws(() => parseBlossomResource(`blossom:${value}`), { code: 'invalid-request' })
  }
  assert.throws(() => parseBlossomResource(`blossom:${hash}?sz=${MAX_RESOURCE_BYTES + 1}`), { code: 'too-large' })
})

it('tries public server hints in order, verifies bytes, then discovers author servers before fallback', async () => {
  const calls = []
  const resolver = createNappletResourceResolver({
    fallbackServers: ['https://fallback.example'],
    loadAuthorServers: async key => { assert.equal(key, author); calls.push('author'); return ['https://author.example/path'] },
    fetchBytes: async (url, init) => {
      calls.push(url)
      assert.equal(init.credentials, 'omit')
      assert.equal(init.redirect, 'error')
      return new Response(url.startsWith('https://author.example/') ? content : 'wrong bytes')
    }
  })
  const response = await resolver(`blossom:${hash}.txt?xs=127.0.0.1&xs=hint.example&as=${author}&sz=17`)
  assert.equal(await response.text(), content)
  assert.deepEqual(calls, [`https://hint.example/${hash}.txt`, `http://hint.example/${hash}.txt`, 'author', `https://author.example/${hash}.txt`])
})

it('uses request servers and manifest fallback without accepting corrupt or incorrectly sized data', async () => {
  const calls = []
  const resolver = createNappletResourceResolver({
    fallbackServers: ['https://fallback.example'], fetchBytes: async url => {
      calls.push(url)
      return new Response(url.includes('fallback') ? content : 'corrupt')
    }
  })
  assert.equal(await (await resolver(`blossom:${hash}`, { servers: ['https://request.example'] })).text(), content)
  assert.equal(calls.length, 2)
  await assert.rejects(resolver(`blossom:${hash}?sz=1`), { code: 'decode-failed' })
})

it('enforces HTTP(S) origin, streaming size, cancellation and post-fetch access checks', async () => {
  let allowed = true
  const controller = new AbortController()
  const resolver = createNappletResourceResolver({ signal: controller.signal, guard: () => { if (!allowed) throw new Error('REVOKED') }, fetchBytes: async () => new Response('ok') })
  assert.equal(await (await resolver('http://public.example/file')).text(), 'ok')
  for (const url of ['http://localhost/file', 'https://user:password@public.example/file', 'http://[::1]/file']) await assert.rejects(resolver(url), { code: 'blocked-by-policy' })
  const huge = createNappletResourceResolver({ fetchBytes: async () => new Response(new Uint8Array(MAX_RESOURCE_BYTES + 1)) })
  await assert.rejects(huge('https://public.example/file'), { code: 'too-large' })
  const revoked = createNappletResourceResolver({ guard: () => { if (!allowed) throw new Error('REVOKED') }, fetchBytes: async () => { allowed = false; return new Response('ok') } })
  await assert.rejects(revoked('https://public.example/file'), /REVOKED/)
  allowed = true
  controller.abort()
  await assert.rejects(resolver(`blossom:${hash}`), { name: 'AbortError' })
})

it('passes BUD-10 and HTTP requests through the installed resource bytesMany service', async () => {
  const service = createResourceService({ fetch: createNappletResourceResolver({ fetchBytes: async () => new Response(content) }), resourceInfo: { schemes: [{ scheme: 'https' }, { scheme: 'blossom' }], maxBytes: MAX_RESOURCE_BYTES } })
  const result = await new Promise(resolve => service.handleMessage('window', {
    type: 'resource.bytesMany', id: 'batch', requests: [
      { url: `blossom:${hash}.txt?xs=cdn.example` }, { url: 'https://public.example/file' }, { url: `blossom:sha256:${hash}` }
    ]
  }, resolve))
  assert.equal(result.type, 'resource.bytesMany.result')
  assert.equal(result.items[0].ok, true)
  assert.equal(await result.items[0].blob.text(), content)
  assert.equal(result.items[1].ok, true)
  assert.equal(result.items[2].error, 'invalid-request')
})

it('cancels pending author discovery without starting fallback downloads', async () => {
  const controller = new AbortController()
  let started
  const discovery = new Promise(resolve => { started = resolve })
  const resolver = createNappletResourceResolver({
    signal: controller.signal,
    loadAuthorServers: () => { started(); return new Promise(() => {}) },
    fallbackServers: ['https://fallback.example'], fetchBytes: () => assert.fail('cancelled request must not fetch')
  })
  const pending = resolver(`blossom:${hash}.txt?as=${author}`)
  await discovery
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})
