import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nfileEncode } from 'libp2r2p/nip19'
import { fileDownloadUrl, parseNfileUrl, attachmentHeaders } from '#helpers/nfile-download-url.js'

const entity = nfileEncode({ root: 'ab'.repeat(32), mime: 'application/pdf', filename: 'résumé.pdf' })
test('download URLs stay on this origin, retain localOnly and bind the app bridge', () => {
  const source = `https://nostr.alt/${entity}?localOnly=1`
  const url = new URL(fileDownloadUrl(source, { origin: 'https://123.44billion.net', bridgeId: 'tab A' }))
  assert.equal(url.origin, 'https://123.44billion.net')
  assert.equal(url.pathname, `/~~nfile/${entity}`)
  assert.equal(url.searchParams.get('localOnly'), '1')
  assert.equal(url.searchParams.get('~~bridgeId'), 'tab A')
  assert.equal(parseNfileUrl(source).reference.filename, 'résumé.pdf')
  for (const invalid of [source.replace('nostr.alt', 'example.com'), source.replace('https:', 'http:'), source + '#fragment', source + '&target=https://example.com', source + '&localOnly=1', source.replace('localOnly=1', 'localOnly=0')]) assert.throws(() => parseNfileUrl(invalid))
  assert.throws(() => fileDownloadUrl(source, { origin: url.origin }))
})
test('attachment headers preserve ranges and MIME while preventing sniffing', () => {
  const headers = attachmentHeaders({ 'content-disposition': "inline; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", 'content-range': 'bytes 1-2/3', 'content-type': 'application/pdf' })
  assert.equal(headers.get('content-disposition'), "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")
  assert.equal(headers.get('content-range'), 'bytes 1-2/3')
  assert.equal(headers.get('content-type'), 'application/pdf')
  assert.equal(headers.get('x-content-type-options'), 'nosniff')
})
