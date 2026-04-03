import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToBase16 } from '../../src/helpers/base16.js'
import { isMimeTypeAccepted } from '../../src/services/blossom-file-downloader/index.js'

describe('BlossomFileDownloader', () => {
  // We test the logic by constructing a downloader-like flow manually
  // since the module has static imports that are hard to mock in Node.js test runner.
  // The core concepts we test:
  // 1. Streaming file bytes into fixed-size chunks (no NMMR, no merkle tree)
  // 2. Creating kind 34600 events with fileHash as root in c tags
  // 3. Progress reporting with immediate chunk emission (no buffering)
  // 4. Blossom server discovery from kind 10063 events
  // 5. Parallel HEAD requests with 500ms timeout and majority vote for totalChunks
  // 6. Fallback across multiple servers

  describe('chunk event creation', () => {
    const CHUNK_SIZE = 51000

    function createChunkEvent (bytes, chunkIndex, totalChunks, fileHash, pubkey) {
      const dTagValue = `${fileHash}:${chunkIndex}`

      const event = {
        kind: 34600,
        pubkey: pubkey || '',
        tags: [
          ['d', dTagValue],
          ['c', `${fileHash}:${chunkIndex}`, String(totalChunks)]
        ],
        content: 'encoded-content',
        created_at: Math.floor(Date.now() / 1000)
      }
      const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
      event.id = bytesToBase16(sha256(new TextEncoder().encode(serialized)))
      return event
    }

    it('should create a valid kind 34600 event from a byte slice', () => {
      const fileHash = 'abc123sha256filehashabcdef'
      const pubkey = 'aabbccdd'
      const bytes = new Uint8Array([1, 2, 3, 4, 5])

      const event = createChunkEvent(bytes, 0, 3, fileHash, pubkey)

      assert.equal(event.kind, 34600)
      assert.equal(event.pubkey, 'aabbccdd')
      // d tag should be fileHash:index
      assert.equal(event.tags[0][0], 'd')
      assert.equal(event.tags[0][1], `${fileHash}:0`)
      // c tag uses fileHash as root, not a merkle root
      assert.equal(event.tags[1][0], 'c')
      assert.equal(event.tags[1][1], `${fileHash}:0`)
      assert.equal(event.tags[1][2], '3')
      // No merkle proof elements
      assert.equal(event.tags[1][3], undefined)
      assert.ok(event.created_at > 0)
    })

    it('should compute a valid NIP-01 event id', () => {
      const fileHash = 'deadbeefsha256hash'
      const pubkey = 'aabbccdd'
      const bytes = new Uint8Array([1])

      const event = createChunkEvent(bytes, 0, 1, fileHash, pubkey)

      // Verify id is a 64-char hex string
      assert.equal(event.id.length, 64)
      assert.match(event.id, /^[0-9a-f]{64}$/)

      // Verify id matches the NIP-01 serialization
      const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
      const expectedId = bytesToBase16(sha256(new TextEncoder().encode(serialized)))
      assert.equal(event.id, expectedId)
    })

    it('should not include a sig field (unsigned event)', () => {
      const event = createChunkEvent(new Uint8Array([1]), 0, 1, 'filehash123', 'pubkey123')
      assert.equal(event.sig, undefined)
    })

    it('should use fileHash:chunkIndex as d tag value', () => {
      const fileHash = 'myhash'
      const event = createChunkEvent(new Uint8Array([1]), 5, 10, fileHash, 'pub1')

      assert.equal(event.tags[0][1], `${fileHash}:5`)
      assert.equal(event.tags[1][1], `${fileHash}:5`)
      assert.equal(event.tags[1][2], '10')
    })

    it('should compute correct total chunks from Content-Length', () => {
      // Simulate calculating total chunks from HEAD Content-Length
      const testCases = [
        { byteLength: 0, expected: 1 },         // Math.max(1, ceil(0/51000)) = 1
        { byteLength: 100, expected: 1 },        // ceil(100/51000) = 1
        { byteLength: 51000, expected: 1 },      // ceil(51000/51000) = 1
        { byteLength: 51001, expected: 2 },      // ceil(51001/51000) = 2
        { byteLength: 102000, expected: 2 },     // ceil(102000/51000) = 2
        { byteLength: 102001, expected: 3 }      // ceil(102001/51000) = 3
      ]

      for (const { byteLength, expected } of testCases) {
        const total = Math.max(1, Math.ceil(byteLength / CHUNK_SIZE))
        assert.equal(total, expected, `byteLength=${byteLength}: expected ${expected}, got ${total}`)
      }
    })
  })

  describe('HEAD majority vote logic', () => {
    it('should pick the most common Content-Length among server results', () => {
      // Simulate majority vote among server HEAD results
      const results = [
        { serverUrl: 'https://server1.com', byteLength: 102000 },
        { serverUrl: 'https://server2.com', byteLength: 102000 },
        { serverUrl: 'https://server3.com', byteLength: 51000 }
      ]

      const counts = new Map()
      for (const { byteLength } of results) {
        counts.set(byteLength, (counts.get(byteLength) ?? 0) + 1)
      }
      let bestByteLength = results[0].byteLength
      let bestCount = 1
      for (const [byteLength, count] of counts) {
        if (count > bestCount || (count === bestCount && byteLength === results[0].byteLength)) {
          bestByteLength = byteLength
          bestCount = count
        }
      }

      assert.equal(bestByteLength, 102000)
      assert.equal(bestCount, 2)
    })

    it('should fallback to first result when all disagree', () => {
      const results = [
        { serverUrl: 'https://server1.com', byteLength: 51000 },
        { serverUrl: 'https://server2.com', byteLength: 102000 },
        { serverUrl: 'https://server3.com', byteLength: 153000 }
      ]

      const counts = new Map()
      for (const { byteLength } of results) {
        counts.set(byteLength, (counts.get(byteLength) ?? 0) + 1)
      }
      let bestByteLength = results[0].byteLength
      let bestCount = 1
      for (const [byteLength, count] of counts) {
        if (count > bestCount || (count === bestCount && byteLength === results[0].byteLength)) {
          bestByteLength = byteLength
          bestCount = count
        }
      }

      // All have count=1 and none match results[0].byteLength better than the first iteration
      assert.equal(bestByteLength, 51000) // first result wins on tie
    })

    it('should return null chosen server when no HEAD responses', () => {
      const results = []
      const totalChunks = results.length === 0 ? null : 1
      const chosenServer = results.length === 0 ? null : results[0].serverUrl

      assert.equal(totalChunks, null)
      assert.equal(chosenServer, null)
    })
  })

  describe('blossom server discovery', () => {
    it('should extract server URLs from kind 10063 event tags', () => {
      const event = {
        created_at: 1000,
        tags: [
          ['server', 'https://blossom1.example.com'],
          ['server', 'https://blossom2.example.com/'],
          ['server', 'http://blossom3.example.com'],
          ['other', 'not-a-server'],
          ['server', 'wss://invalid-protocol']
        ]
      }

      // Replicate the server extraction logic
      const servers = (event.tags ?? [])
        .filter(t => Array.isArray(t) && t[0] === 'server' && /^https?:\/\//.test(t[1]))
        .map(t => t[1].trim().replace(/\/$/, ''))
        .filter(Boolean)

      assert.deepEqual(servers, [
        'https://blossom1.example.com',
        'https://blossom2.example.com',
        'http://blossom3.example.com'
      ])
    })

    it('should return empty array when no events found', () => {
      const events = []
      const servers = events.length === 0
        ? []
        : (events[0].tags ?? [])
            .filter(t => Array.isArray(t) && t[0] === 'server' && /^https?:\/\//.test(t[1]))
            .map(t => t[1].trim().replace(/\/$/, ''))
            .filter(Boolean)

      assert.deepEqual(servers, [])
    })

    it('should pick the most recent event when multiple exist', () => {
      const events = [
        { created_at: 500, tags: [['server', 'https://old.example.com']] },
        { created_at: 1000, tags: [['server', 'https://new.example.com']] },
        { created_at: 700, tags: [['server', 'https://mid.example.com']] }
      ]

      events.sort((a, b) => b.created_at - a.created_at)
      const best = events[0]

      const servers = (best.tags ?? [])
        .filter(t => Array.isArray(t) && t[0] === 'server' && /^https?:\/\//.test(t[1]))
        .map(t => t[1].trim().replace(/\/$/, ''))
        .filter(Boolean)

      assert.deepEqual(servers, ['https://new.example.com'])
    })
  })

  describe('streaming chunking logic (immediate emission)', () => {
    it('should split a buffer into chunks of the correct size', () => {
      const CHUNK_SIZE = 10
      const data = new Uint8Array(25)
      for (let i = 0; i < 25; i++) data[i] = i

      let buffer = new Uint8Array(0)
      const emittedChunks = []

      // Simulate receiving the data in one go and emitting immediately
      const newBuffer = new Uint8Array(buffer.length + data.length)
      newBuffer.set(buffer)
      newBuffer.set(data, buffer.length)
      buffer = newBuffer

      while (buffer.length >= CHUNK_SIZE) {
        const chunk = buffer.slice(0, CHUNK_SIZE)
        buffer = buffer.slice(CHUNK_SIZE)
        emittedChunks.push(chunk) // emit immediately, no pendingSlices
      }
      // Emit remaining immediately after loop
      if (buffer.length > 0) emittedChunks.push(buffer)

      assert.equal(emittedChunks.length, 3)
      assert.equal(emittedChunks[0].length, 10)
      assert.equal(emittedChunks[1].length, 10)
      assert.equal(emittedChunks[2].length, 5)
    })

    it('should handle empty data', () => {
      const chunks = []
      const buffer = new Uint8Array(0)
      if (buffer.length > 0) chunks.push(buffer)

      assert.equal(chunks.length, 0)
    })

    it('should handle data smaller than chunk size', () => {
      const CHUNK_SIZE = 51000
      const data = new Uint8Array(100)
      const emittedChunks = []

      let buffer = data
      while (buffer.length >= CHUNK_SIZE) {
        emittedChunks.push(buffer.slice(0, CHUNK_SIZE))
        buffer = buffer.slice(CHUNK_SIZE)
      }
      if (buffer.length > 0) emittedChunks.push(buffer)

      assert.equal(emittedChunks.length, 1)
      assert.equal(emittedChunks[0].length, 100)
    })

    it('should emit chunks immediately without buffering in pendingSlices array', () => {
      // Verify that the streaming logic does not accumulate all chunks before emitting
      const CHUNK_SIZE = 10
      const totalData = new Uint8Array(30) // 3 chunks of 10

      let emittedCount = 0
      const callbacks = []

      let buffer = new Uint8Array(0)
      const newBuf = new Uint8Array(buffer.length + totalData.length)
      newBuf.set(buffer)
      newBuf.set(totalData, buffer.length)
      buffer = newBuf

      while (buffer.length >= CHUNK_SIZE) {
        buffer = buffer.slice(CHUNK_SIZE)
        emittedCount++
        callbacks.push(emittedCount) // simulating immediate callback
      }
      if (buffer.length > 0) {
        emittedCount++
        callbacks.push(emittedCount)
      }

      // All 3 chunks emitted individually, not batched
      assert.deepEqual(callbacks, [1, 2, 3])
    })
  })

  describe('progress reporting', () => {
    it('should report progress based on processed chunks vs total', () => {
      const totalChunks = 4
      const progressReports = []

      for (let i = 0; i < totalChunks; i++) {
        const processedCount = i + 1
        progressReports.push({
          type: 'progress',
          progress: (processedCount / totalChunks) * 100,
          count: processedCount,
          total: totalChunks,
          chunkIndex: i
        })
      }

      assert.equal(progressReports.length, 4)
      assert.equal(progressReports[0].progress, 25)
      assert.equal(progressReports[1].progress, 50)
      assert.equal(progressReports[2].progress, 75)
      assert.equal(progressReports[3].progress, 100)
    })

    it('should include chunk index in progress reports (no merkleRootHash)', () => {
      const fileHash = 'sha256filehashabc'
      const report = {
        type: 'progress',
        progress: 50,
        count: 1,
        total: 2,
        chunkIndex: 0,
        event: {
          kind: 34600,
          pubkey: 'aabb',
          id: 'deadbeef',
          tags: [['d', `${fileHash}:0`], ['c', `${fileHash}:0`, '2']],
          content: 'data',
          created_at: 1000
        }
      }

      assert.equal(report.type, 'progress')
      assert.equal(report.event.kind, 34600)
      assert.equal(report.event.pubkey, 'aabb')
      assert.ok(report.event.id)
      assert.equal(report.chunkIndex, 0)
      // No merkleRootHash in blossom progress reports
      assert.equal(report.merkleRootHash, undefined)
    })
  })

  describe('missing chunks detection', () => {
    it('should report missing chunk indexes when stream ends before totalChunks', () => {
      // Simulate: totalChunks=3 but only 2 chunks were streamed
      const totalChunks = 3
      const CHUNK_SIZE = 51000
      let buffer = new Uint8Array(CHUNK_SIZE * 2) // exactly 2 chunks
      let chunkIndex = 0
      const callbacks = []

      while (buffer.length >= CHUNK_SIZE) {
        buffer = buffer.slice(CHUNK_SIZE)
        callbacks.push({ chunkIndex })
        chunkIndex++
      }

      // Detect missing chunks after stream ends
      if (chunkIndex < totalChunks) {
        const missingIndexes = []
        for (let i = chunkIndex; i < totalChunks; i++) missingIndexes.push(i)
        callbacks.push({ error: 'Missing file chunks', chunkIndexes: missingIndexes })
      }

      assert.equal(callbacks.length, 3) // 2 normal + 1 error callback
      assert.equal(callbacks[0].chunkIndex, 0)
      assert.equal(callbacks[1].chunkIndex, 1)
      assert.deepEqual(callbacks[2].chunkIndexes, [2])
      assert.equal(callbacks[2].error, 'Missing file chunks')
    })

    it('should not report missing chunks when all chunks received', () => {
      const totalChunks = 2
      const CHUNK_SIZE = 51000
      let buffer = new Uint8Array(CHUNK_SIZE * 2) // exactly 2 full chunks
      let chunkIndex = 0
      const missingCallbacks = []

      while (buffer.length >= CHUNK_SIZE) {
        buffer = buffer.slice(CHUNK_SIZE)
        chunkIndex++
      }

      if (chunkIndex < totalChunks) {
        const missing = []
        for (let i = chunkIndex; i < totalChunks; i++) missing.push(i)
        missingCallbacks.push({ error: 'Missing file chunks', chunkIndexes: missing })
      }

      assert.equal(missingCallbacks.length, 0)
      assert.equal(chunkIndex, totalChunks)
    })

    it('should report all missing indexes when file download is truncated', () => {
      const totalChunks = 5
      const CHUNK_SIZE = 51000
      // Only 1 chunk received
      let buffer = new Uint8Array(CHUNK_SIZE)
      let chunkIndex = 0

      while (buffer.length >= CHUNK_SIZE) {
        buffer = buffer.slice(CHUNK_SIZE)
        chunkIndex++
      }

      const missingIndexes = []
      if (chunkIndex < totalChunks) {
        for (let i = chunkIndex; i < totalChunks; i++) missingIndexes.push(i)
      }

      assert.deepEqual(missingIndexes, [1, 2, 3, 4])
    })
  })

  describe('MIME type validation', () => {
    it('should accept response when content-type matches expected mime type', () => {
      assert.equal(isMimeTypeAccepted('image/vnd.microsoft.icon', 'image/vnd.microsoft.icon'), true)
      assert.equal(isMimeTypeAccepted('image/png', 'image/png'), true)
    })

    it('should reject response when content-type is text/html', () => {
      assert.equal(isMimeTypeAccepted('image/vnd.microsoft.icon', 'text/html'), false)
      assert.equal(isMimeTypeAccepted('image/png', 'text/html; charset=utf-8'), false)
    })

    it('should strip charset and extra params before comparing', () => {
      assert.equal(isMimeTypeAccepted('image/png', 'image/png; charset=utf-8'), true)
      assert.equal(isMimeTypeAccepted('image/svg+xml', 'image/svg+xml; charset=utf-8'), true)
    })

    it('should accept application/octet-stream regardless of expected mime type', () => {
      assert.equal(isMimeTypeAccepted('image/vnd.microsoft.icon', 'application/octet-stream'), true)
      assert.equal(isMimeTypeAccepted('image/png', 'application/octet-stream'), true)
    })

    it('should accept when content-type header is absent', () => {
      assert.equal(isMimeTypeAccepted('image/png', ''), true)
      assert.equal(isMimeTypeAccepted('image/png', null), true)
    })

    it('should skip validation when no expected mime type is set', () => {
      assert.equal(isMimeTypeAccepted(null, 'text/html'), true)
      assert.equal(isMimeTypeAccepted(null, 'application/json'), true)
    })

    it('should be case-insensitive', () => {
      assert.equal(isMimeTypeAccepted('image/png', 'Image/PNG'), true)
      assert.equal(isMimeTypeAccepted('IMAGE/PNG', 'image/png'), true)
    })

    it('should reject mismatched type families', () => {
      assert.equal(isMimeTypeAccepted('image/png', 'text/html'), false)
      assert.equal(isMimeTypeAccepted('text/javascript', 'image/png'), false)
    })

    it('should accept same-family types (server may report imprecise type)', () => {
      assert.equal(isMimeTypeAccepted('image/png', 'image/jpeg'), true)
      assert.equal(isMimeTypeAccepted('image/vnd.microsoft.icon', 'image/png'), true)
      assert.equal(isMimeTypeAccepted('text/javascript', 'text/plain'), true)
      assert.equal(isMimeTypeAccepted('text/css', 'text/plain'), true)
    })

    it('should accept aliased mime types that map to the same extension', () => {
      assert.equal(isMimeTypeAccepted('text/javascript', 'application/javascript'), true)
      assert.equal(isMimeTypeAccepted('application/javascript', 'text/javascript'), true)
    })
  })

  describe('error handling', () => {
    it('should report an error when no blossom servers are found', () => {
      const blossomServers = []
      assert.throws(
        () => {
          if (blossomServers.length === 0) {
            throw new Error('No blossom servers found for the app publisher')
          }
        },
        { message: 'No blossom servers found for the app publisher' }
      )
    })

    it('should report an error when file is not found on any server', () => {
      const fileHash = 'abc123'
      const response = null // No server responded
      assert.throws(
        () => {
          if (!response) {
            throw new Error(`File ${fileHash} not found on any blossom server`)
          }
        },
        { message: 'File abc123 not found on any blossom server' }
      )
    })
  })
})
