import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import { sha256 } from '@noble/hashes/sha2.js'
import NMMR from 'nmmr'
import { decode } from 'libp2r2p/base93'
import { bytesToBase16 } from 'libp2r2p/base16'
import BlossomFileDownloader, { isMimeTypeAccepted } from '#services/blossom-file-downloader/index.js'
import { relayPool as nostrRelays } from 'libp2r2p/relay'

const PUBKEY = 'a'.repeat(64)

function hash (bytes) {
  return bytesToBase16(sha256(bytes))
}

async function runDownload (bytes, {
  advertisedHash = hash(bytes),
  size = bytes.length,
  headLength = bytes.length,
  getLengths = [bytes.length]
} = {}) {
  const getEvents = mock.method(nostrRelays, 'getEvents', async () => ({
    result: [{ kind: 10063, created_at: 1, tags: [['server', 'https://blossom.test']] }]
  }))
  const previousFetch = globalThis.fetch
  let getCount = 0
  globalThis.fetch = mock.fn(async (_url, options = {}) => {
    if (options.method === 'HEAD') {
      const headers = headLength === null ? {} : { 'Content-Length': String(headLength) }
      return new Response(null, { status: 200, headers })
    }
    const getLength = getLengths[Math.min(getCount, getLengths.length - 1)]
    getCount++
    const headers = { 'Content-Type': 'application/octet-stream' }
    if (getLength !== null) headers['Content-Length'] = String(getLength)
    return new Response(bytes, {
      status: 200,
      headers
    })
  })
  const reports = []
  try {
    await new BlossomFileDownloader(advertisedHash, PUBKEY, ['wss://relay.test'], report => reports.push(report), { size }).run()
  } finally {
    getEvents.mock.restore()
    globalThis.fetch = previousFetch
  }
  return { getCount, reports }
}

afterEach(() => mock.restoreAll())

describe('BlossomFileDownloader pseudo chunks', () => {
  it('creates unsigned local kind 34601 events using derived d and empty proof', async () => {
    const bytes = new Uint8Array(51003).fill(7)
    const fileHash = hash(bytes)
    const { reports } = await runDownload(bytes)
    const chunks = reports.filter(report => report.event)
    assert.equal(chunks.length, 2)
    assert.deepEqual(chunks.map(report => report.event.kind), [34601, 34601])
    assert.deepEqual(chunks[0].event.tags, [
      ['d', NMMR.deriveChunkId(fileHash, 0)],
      ['mmr', '0', '2', '']
    ])
    assert.equal(chunks[0].event.sig, undefined)
    assert.equal(decode(chunks[0].event.content).length, 51000)
    assert.deepEqual([...decode(chunks[1].event.content)], [7, 7, 7])
  })

  it('emits one empty pseudo chunk for an empty Blossom file', async () => {
    const { reports } = await runDownload(new Uint8Array())
    const event = reports.find(report => report.event)?.event
    assert.ok(event)
    assert.deepEqual(event.tags[1], ['mmr', '0', '1', ''])
    assert.equal(event.content, '')
  })

  it('reports a hash mismatch so the caller can discard streamed cache rows', async () => {
    const { reports } = await runDownload(Uint8Array.of(1, 2, 3), {
      advertisedHash: '0'.repeat(64),
      size: 3
    })
    assert.match(reports.find(report => report.error).error.message, /hash|length/)
  })

  it('treats a wrong manifest size and same-range Content-Length as hints', async () => {
    const consoleWarn = mock.method(console, 'warn', () => {})
    const bytes = Uint8Array.of(4, 5, 6)
    const { getCount, reports } = await runDownload(bytes, {
      size: 999,
      headLength: 2,
      getLengths: [2]
    })

    assert.equal(getCount, 1)
    assert.equal(reports.some(report => report.error), false)
    assert.equal(reports.at(-1).progress, 100)
    assert.equal(consoleWarn.mock.callCount(), 1)
  })

  it('replays once when Content-Length predicts the wrong chunk total', async () => {
    mock.method(console, 'warn', () => {})
    const bytes = new Uint8Array(51001).fill(8)
    const { getCount, reports } = await runDownload(bytes, {
      size: null,
      headLength: 51000,
      getLengths: [51000, 51000]
    })

    assert.equal(getCount, 2, JSON.stringify(reports.map(report => ({
      type: report.type,
      error: report.error?.message,
      discardChunks: report.discardChunks,
      progress: report.progress
    }))))
    assert.equal(reports.filter(report => report.discardChunks).length, 1)
    const correctedEvents = reports.filter(report => report.event?.tags[1][2] === '2')
    assert.deepEqual(correctedEvents.map(report => report.chunkIndex), [0, 1])
    assert.equal(reports.at(-1).progress, 100)
    assert.equal(reports.some(report => report.error), false)
  })

  it('does not emit an invalid partial chunk when Content-Length predicts too many chunks', async () => {
    mock.method(console, 'warn', () => {})
    const bytes = Uint8Array.of(12, 13, 14)
    const { getCount, reports } = await runDownload(bytes, {
      size: null,
      headLength: 51001,
      getLengths: [51001, 51001]
    })

    assert.equal(getCount, 2)
    assert.equal(reports.filter(report => report.discardChunks).length, 1)
    const events = reports.filter(report => report.event)
    assert.equal(events.length, 1)
    assert.deepEqual(events[0].event.tags[1], ['mmr', '0', '1', ''])
    assert.equal(reports.at(-1).progress, 100)
    assert.equal(reports.some(report => report.error), false)
  })

  it('uses a validation pass when Content-Length and manifest size are absent', async () => {
    const bytes = Uint8Array.of(9, 10, 11)
    const { getCount, reports } = await runDownload(bytes, {
      size: null,
      headLength: null,
      getLengths: [null, null]
    })

    assert.equal(getCount, 2, JSON.stringify(reports.map(report => ({
      type: report.type,
      error: report.error?.message,
      discardChunks: report.discardChunks,
      progress: report.progress
    }))))
    assert.equal(reports.filter(report => report.event).length, 1)
    assert.equal(reports.at(-1).progress, 100)
    assert.equal(reports.some(report => report.error), false)
  })
})

describe('Blossom MIME checks', () => {
  it('accepts aliases and generic octet streams but rejects a wrong family', () => {
    assert.equal(isMimeTypeAccepted('image/jpeg', 'image/jpg'), true)
    assert.equal(isMimeTypeAccepted('image/webp', 'application/octet-stream'), true)
    assert.equal(isMimeTypeAccepted('image/webp', 'text/html'), false)
  })
})
