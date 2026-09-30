import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { prepareIrfsFile } from 'libp2r2p/irfs'
function device (t) {
  const worker = new Worker(new URL('../helpers/recovery-device.js', import.meta.url))
  const pending = new Map(); let serial = 0
  worker.on('message', ({ id, result, error }) => { const task = pending.get(id); pending.delete(id); error ? task.reject(Object.assign(new Error(error.message), { stack: error.stack })) : task.resolve(result) })
  worker.on('error', error => { for (const task of pending.values()) task.reject(error); pending.clear() })
  t.after(() => worker.terminate())
  return (method, value) => new Promise((resolve, reject) => { const id = serial++; pending.set(id, { resolve, reject }); worker.postMessage({ id, method, value }) })
}
test('a second isolated device serves synced grants/chunks after sender disappears and honors synced deletion', async t => {
  const a = device(t); const b = device(t)
  const prepared = await prepareIrfsFile(new Uint8Array(77).fill(21))
  t.after(() => prepared.close())
  const event = (await prepared.chunks().next()).value
  const time = Math.floor(Date.now() / 1000)
  const file = { controlChannelPubkey: 'a'.repeat(64), fileChannelPubkey: 'b'.repeat(64), peerPubkey: 'c'.repeat(64), receiverPubkey: 'c'.repeat(64), root: prepared.root, size: prepared.size, sharedAt: time - 10, expiresAt: time + 604800 }
  await a('chunk', { event, file }); await a('grant', file)
  const snapshot = await a('export')
  await b('import', snapshot)
  const grant = await b('find', file)
  assert.equal(grant.sharedAt, file.sharedAt)
  const replies = await b('serve', { file, receiver: file.receiverPubkey })
  assert.ok(replies.every(reply => !reply.error))
  const records = replies.flatMap(reply => reply.payload.jsonl.split('\n').filter(Boolean).map(line => JSON.parse(line)))
  assert.equal(records.length, 1)
  const [record] = records
  assert.equal(record.recordType, 'irfsChunk_v1')
  assert.equal(record.content, event.content)
  assert.deepEqual(await b('serve', { file, receiver: 'd'.repeat(64) }), [])
  await a('revoke', await a('find', file))
  await b('import', await a('export'))
  assert.equal(await b('find', file), undefined)
  assert.deepEqual(await b('serve', { file, receiver: file.receiverPubkey }), [])
})

test('a paired watchtower serves synced ciphertext without local plaintext chunks', async t => {
  const a = device(t); const b = device(t)
  const time = Math.floor(Date.now() / 1000)
  const file = { controlChannelPubkey: 'a'.repeat(64), fileChannelPubkey: 'b'.repeat(64), peerPubkey: 'c'.repeat(64), root: 'd'.repeat(64) }
  const row = { ...file, recordType: 'routerEnvelopeRow_v1', receiverPubkey: file.peerPubkey, chunkIndex: 0, receivedAt: time - 10, expiresAt: time + 604800, firstSeenAt: time - 10, lastSeenAt: time - 10, router: { kind: 26300, pubkey: 'e'.repeat(64), created_at: time - 10, tags: [['f', 'f'.repeat(64)], ['i', '0'], ['p', file.peerPubkey]] }, payloadRow: '["encrypted-payload"]', row: JSON.stringify([file.peerPubkey, 'encrypted-message-key']) }
  await a('seed', row)
  await b('import', await a('export'))
  const replies = await b('serve', { file, receiver: file.peerPubkey, mode: 'watchtower' })
  assert.ok(replies.every(reply => !reply.error))
  const records = replies.flatMap(reply => reply.payload.jsonl.split('\n').filter(Boolean).map(line => JSON.parse(line)))
  assert.equal(records.length, 1)
  const [record] = records
  assert.equal(record.recordType, 'routerEnvelopeRow_v1')
  const lines = Buffer.from(record.router.content, 'base64').toString('utf8').trim().split('\n')
  assert.deepEqual(lines.map(line => JSON.parse(line)), [['encrypted-payload'], [file.peerPubkey, 'encrypted-message-key']])
  assert.deepEqual(await b('serve', { file, receiver: '9'.repeat(64), mode: 'watchtower' }), [])
})
