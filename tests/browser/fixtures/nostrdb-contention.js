import { getNostrDb, openNostrDb, toStoredRecord, eventIdIndexKey, isNewer } from '#services/idb/nostrdb/index.js'
import { createLocalPersonalCopy } from '#services/idb/nostrdb/personal-copy.js'
import { getNostrDbQuotaUsage, QUOTA_LOCK } from '#services/idb/nostrdb/quotas.js'
import { finalizeEvent, getEventHash } from 'libp2r2p/event'
import { getPublicKey } from 'libp2r2p/key'
import { encryptBytes } from 'libp2r2p/nip44-v3'

const secret = new Uint8Array(32).fill(21)
const contentSecret = new Uint8Array(32).fill(22)
const owner = getPublicKey(secret)
const contentPubkey = getPublicKey(contentSecret)
const obfuscate = async (value, kind, scope) => `${kind}:${scope}:${value}`
const encrypt = async (kind, plaintext) => encryptBytes(secret, owner, kind, new Uint8Array(), new TextEncoder().encode(plaintext))
const signEvent = async template => {
  const proofless = { ...template, tags: template.tags.map(tag => tag[0] === 'imkc' ? ['imkc', contentPubkey] : tag) }
  const proof = finalizeEvent(proofless, contentSecret)
  return finalizeEvent({ ...template, tags: template.tags.map(tag => tag[0] === 'imkc' ? ['imkc', contentPubkey, proof.sig] : tag) }, secret)
}
const copy = (originalEvent, context = '') => createLocalPersonalCopy({ originalEvent, context, ownerPubkey: owner, obfuscate, encrypt, signEvent })
const db = getNostrDb(owner, { maintenance: false, personalCopyObfuscate: obfuscate })
const raw = await openNostrDb(owner)
for (const value of [23, 24]) await openNostrDb(getPublicKey(new Uint8Array(32).fill(value)))
const done = tx => new Promise((resolve, reject) => { tx.addEventListener('complete', resolve); tx.addEventListener('abort', () => reject(tx.error)) })
const profiles = Array.from({ length: 104 }, (_, i) => finalizeEvent({ kind: 0, created_at: 1, tags: [], content: '{}' }, new Uint8Array(32).fill(80 + i)))
let serial = 0
let materialized = 0
const originalCursor = IDBIndex.prototype.openCursor
IDBIndex.prototype.openCursor = function (...args) {
  const request = originalCursor.apply(this, args)
  if (this.name === 'byTag') request.addEventListener('success', () => { if (request.result) materialized++ })
  return request
}
const lookup = id => db.query({ kinds: [1006], authors: [owner], '#k': ['30078'], '#c': [awaitContext], '#v': ['0', '1'], '&o': ['1006:#t:seed', `1006:#d:${id}`] })
const awaitContext = await obfuscate('', 1006, '')
const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) })

globalThis.fixture = {
  owner, QUOTA_LOCK,
  async seed (count = 15000) {
    const template = await copy({ kind: 30078, created_at: 1, tags: [['d', 'template'], ['t', 'seed']], content: '' })
    for (let offset = 0; offset < count; offset += 500) {
      const tx = raw.transaction(['events', 'maintenance'], 'readwrite')
      const finished = done(tx)
      const store = tx.objectStore('events')
      const usage = await request(tx.objectStore('maintenance').get('quotaUsage'))
      for (let i = offset; i < Math.min(count, offset + 500); i++) {
        // Synthetic cardinality fixtures: old rows are inserted directly, not
        // advertised as protocol-validated history. New writes use real crypto.
        const event = { ...template, id: (i + 1).toString(16).padStart(64, '0'), tags: template.tags.map(tag => tag[0] === 'd' ? ['d', `fixture-coordinate-${i}`] : tag[0] === 'o' && tag[1].startsWith('1006:.id:') ? ['o', `fixture-source-${i}`] : tag[0] === 'o' && tag[1].startsWith('1006:#d:') ? ['o', `1006:#d:fixture-${i}`] : tag) }
        const row = toStoredRecord(event)
        row.eventBytes = new TextEncoder().encode(JSON.stringify(event)).length
        row.ownerRefs = []; row.sa = 1000 + i
        store.put(row); usage.privateBytes += row.eventBytes; usage.privateCount++
      }
      tx.objectStore('maintenance').put(usage)
      await finished
    }
    for (const profile of profiles) {
      const result = await db.add(profile)
      if (!result.ok) throw new Error('profile fixture admission failed')
    }
    return getNostrDbQuotaUsage()
  },
  async round () {
    materialized = 0
    const measures = []
    const observe = flow => value => measures.push({ ...value, flow })
    const start = performance.now()
    const key = `new-seed-${++serial}`
    const background = lookup(key).then(async () => {
      const event = await copy({ kind: 30078, created_at: 2 + serial, tags: [['d', key], ['t', 'seed']], content: '' })
      const result = await db.add(event, { onTiming: observe('archive') })
      if (!result.ok) throw new Error('archive admission failed')
    })
    const duplicates = Promise.all(profiles.map(profile => db.add(profile, { onTiming: observe('profile') })))
    const event = await copy({ kind: 9, created_at: 100 + serial, tags: [], content: `generated-${serial}` }, `dm:${owner}`)
    const foregroundStart = performance.now()
    const result = await db.add(event, { onTiming: observe('foreground') })
    const foregroundMs = performance.now() - foregroundStart
    if (!result.ok) throw new Error('foreground admission failed')
    await Promise.all([background, duplicates])
    return {
      foregroundMs, totalMs: performance.now() - start, materialized,
      foregroundQuotaWaitMs: measures.filter(row => row.flow === 'foreground' && row.stage === 'quota-lock-wait').reduce((sum, row) => sum + row.elapsedMs, 0),
      foregroundQuotaHeldMs: measures.filter(row => row.flow === 'foreground' && row.stage === 'quota-lock-execution').reduce((sum, row) => sum + row.elapsedMs, 0),
      duplicateReads: measures.filter(row => row.stage === 'duplicate-read').length,
      planningMs: measures.filter(row => row.stage === 'query-planning').reduce((sum, row) => sum + row.elapsedMs, 0),
      quotaWaitMs: measures.filter(row => row.stage === 'quota-lock-wait').map(row => row.elapsedMs),
      quotaHeldMs: measures.filter(row => row.stage === 'quota-lock-execution').map(row => row.elapsedMs)
    }
  },
  duplicate: () => db.add(profiles[0]),
  usage: getNostrDbQuotaUsage,
  async prepareRace () {
    const originalEvent = { kind: 9, created_at: 999, tags: [], content: 'concurrent fixed identity' }
    const event = await copy(originalEvent, 'race')
    globalThis.raceEvent = event
    return { id: event.id, source: getEventHash({ ...originalEvent, pubkey: owner }) }
  },
  race: () => db.add(globalThis.raceEvent),
  async raceWinner () {
    const { results } = await db.query({ kinds: [1006], '#c': ['1006::race'] })
    return results.map(event => event.id)
  },
  preferred: (a, b) => isNewer({ id: a, created_at: 999 }, { id: b, created_at: 999 }) ? a : b,
  async publicCount () { return (await getNostrDbQuotaUsage()).cacheCount },
  async has (id) { return !!await request(raw.transaction('events').objectStore('events').get(eventIdIndexKey(id))) }
}
