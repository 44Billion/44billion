// Isolated IndexedDB and module state for each simulated paired device.
import { parentPort } from 'node:worker_threads'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'
import { finalizeEvent } from 'libp2r2p/event'
import { getPublicKey } from 'libp2r2p/key'
import { encryptBytes, decryptBytes } from 'libp2r2p/nip44-v3'
import { createPersonalCopyRecoveryStorage, createEventStoreChunkStorage } from 'libp2r2p/private-messenger/event-store'
import { createPrivateFileTransfer } from 'libp2r2p/private-messenger/file'
import { getNostrDb } from '#services/idb/nostrdb/index.js'
import { runNostrDbMethod } from '#helpers/window-message/browser/nostrdb.js'
globalThis.indexedDB = indexedDB
globalThis.IDBKeyRange = IDBKeyRange
globalThis.localStorage = { getItem: () => null, setItem () {} }
const secret = new Uint8Array(32).fill(43); const owner = getPublicKey(secret)
const contentKey = new Uint8Array(32).fill(44); const contentPubkey = getPublicKey(contentKey)
const obfuscate = async (value, kind, scope) => `${kind}:${scope}:${value}`
const encrypt = async (kind, value) => encryptBytes(secret, owner, kind, new Uint8Array(), new TextEncoder().encode(value))
const decrypt = async event => new TextDecoder().decode(decryptBytes(secret, owner, Number(event.tags.find(t => t[0] === 'k')[1]), new Uint8Array(), event.content))
const signEvent = async event => {
  const proof = finalizeEvent({ ...event, tags: event.tags.map(t => t[0] === 'imkc' ? ['imkc', contentPubkey] : t) }, contentKey)
  return finalizeEvent({ ...event, tags: event.tags.map(t => t[0] === 'imkc' ? ['imkc', contentPubkey, proof.sig] : t) }, secret)
}
const db = getNostrDb(owner, { maintenance: false, personalCopyDecrypt: decrypt, personalCopyEncrypt: encrypt, personalCopyObfuscate: obfuscate })
const eventStore = {
  query: (...args) => db.query(...args), remove: (...args) => db.remove(...args),
  addPersonalCopy: (inner, options) => runNostrDbMethod({ db, method: 'addPersonalCopy', params: [inner, options], signEvent, personalCopyEncrypt: encrypt, personalCopyObfuscate: obfuscate, requestPermission: async () => {} })
}
const signer = { getPublicKey: async () => owner, obfuscate, nip44v3: { decrypt: async (pubkey, kind, scope, text) => decryptBytes(secret, pubkey, kind, new Uint8Array(), text).slice().buffer } }
const persistence = createPersonalCopyRecoveryStorage({ eventStore, signer })
const chunks = createEventStoreChunkStorage({ eventStore })
let coordinator; let feed; let replies = []
const methods = {
  grant: row => persistence.authorizations.put(row),
  seed: row => persistence.seeds.put(row),
  chunk: ({ event, file }) => chunks.save(event, file),
  export: async () => (await db.query({ limit: 1000 })).results,
  import: async events => { for (const event of events) { const result = await db.add(event, { signEvent, mergeSource: 'sync' }); if (!result.ok) throw new Error(result.code) } },
  find: query => persistence.authorizations.find(query),
  revoke: row => persistence.authorizations.revoke([row]),
  async serve ({ file, receiver, mode = 'seeder' }) {
    await coordinator?.close(); replies = []
    const parent = { mode, pubkey: file.controlChannelPubkey }
    const messenger = { prefix: `test:${owner}`, userPubkey: owner, extensions: new Set(), _indexedDB: indexedDB, channels: new Map([[parent.pubkey, parent]]), desiredChannels: new Set([parent.pubkey]), offlineRecoverySecondsFor: () => 604800, requireWritableChannel: () => parent, resolveSendRouting: async () => ({ relays: [] }), eventExpirationSecondsFor: () => 604800, contentKeyLookup: () => undefined }
    coordinator = createPrivateFileTransfer({ messenger, resolveChannel: async () => ({ getPublicKey: async () => file.fileChannelPubkey }), storage: chunks, authorizationStorage: persistence.authorizations, seedStorage: persistence.seeds, _messages: { reply: async value => { replies.push({ payload: value.payload, code: value.code }); return { delivery: { reports: [{ success: true }] } } } }, onError: error => replies.push({ error: error.message }) })
    feed = [...messenger.extensions][0]
    const question = { id: 'a'.repeat(64), kind: 7329, pubkey: receiver, created_at: Math.floor(Date.now() / 1000), tags: [['r', owner]], content: '' }
    feed.handleAsk(parent.pubkey, { senderPubkey: receiver, provenance: 'direct', question, payload: { code: 'fileChunksRequest_p5cc', payload: { fileChannelPubkey: file.fileChannelPubkey, missingRanges: [[0, 0]] } } })
    // close drains already admitted reply work, but must not cancel it first.
    for (let i = 0; i < 100 && !replies.some(reply => reply.error || reply.payload?.isLast); i++) await new Promise(resolve => setTimeout(resolve, 5))
    return replies
  }
}
parentPort.on('message', async ({ id, method, value }) => {
  try { parentPort.postMessage({ id, result: await methods[method](value) }) } catch (error) { parentPort.postMessage({ id, error: { message: error.message, stack: error.stack } }) }
})
