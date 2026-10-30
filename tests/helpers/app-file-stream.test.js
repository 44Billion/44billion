import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamAppFileChunks } from '../../src/helpers/app-file-stream.js'

function chunk (index, total) {
  return {
    evt: {
      content: `chunk-${index}`,
      tags: [['mmr', String(index), String(total), '']]
    }
  }
}

test('holds a provisional Blossom final chunk until validation completes', async () => {
  const chunks = new Map(Array.from({ length: 6 }, (_, index) => [index, chunk(index, 6)]))
  const sent = []
  let terminalCount = 0
  const stream = options => streamAppFileChunks({
    loadChunk: async index => chunks.get(index) ?? null,
    sendChunk: item => sent.push([item.index, item.isLast]),
    sendTerminal: () => { terminalCount++ },
    ...options
  })

  const first = await stream({
    startIndex: 0,
    totalChunks: 1,
    downloadValidated: false
  })
  assert.equal(first.nextIndex, 0)
  assert.equal(first.hasSentLast, false)
  assert.deepEqual(sent, [])

  const second = await stream({
    startIndex: first.nextIndex,
    totalChunks: 6,
    downloadValidated: false
  })
  assert.equal(second.nextIndex, 5)
  assert.equal(second.hasSentLast, false)
  assert.deepEqual(sent, [
    [0, false],
    [1, false],
    [2, false],
    [3, false],
    [4, false]
  ])

  const completed = await stream({
    startIndex: second.nextIndex,
    totalChunks: second.totalChunks,
    downloadValidated: true
  })
  assert.equal(completed.nextIndex, 6)
  assert.equal(completed.hasSentLast, true)
  assert.deepEqual(sent.at(-1), [5, true])
  assert.equal(terminalCount, 0)
})

test('uses the validated total instead of an earlier provisional hint', async () => {
  const chunks = new Map(Array.from({ length: 6 }, (_, index) => [index, chunk(index, 6)]))
  const sent = []

  const held = await streamAppFileChunks({
    startIndex: 0,
    totalChunks: 1,
    downloadValidated: false,
    loadChunk: async index => chunks.get(index) ?? null,
    sendChunk: ({ index, isLast }) => sent.push([index, isLast]),
    sendTerminal: () => assert.fail('a real final chunk remains')
  })
  assert.equal(held.nextIndex, 0)
  assert.deepEqual(sent, [])

  const completed = await streamAppFileChunks({
    startIndex: held.nextIndex,
    totalChunks: 6,
    downloadValidated: true,
    loadChunk: async index => chunks.get(index) ?? null,
    sendChunk: ({ index, isLast }) => sent.push([index, isLast]),
    sendTerminal: () => assert.fail('a real final chunk remains')
  })
  assert.equal(completed.hasSentLast, true)
  assert.deepEqual(sent, [
    [0, false],
    [1, false],
    [2, false],
    [3, false],
    [4, false],
    [5, true]
  ])
})

test('sends an empty terminal frame when an oversized hint already streamed every chunk', async () => {
  const chunks = new Map(Array.from({ length: 3 }, (_, index) => [index, chunk(index, 3)]))
  const sent = []
  let terminalCount = 0

  const first = await streamAppFileChunks({
    startIndex: 0,
    totalChunks: 4,
    downloadValidated: false,
    loadChunk: async index => chunks.get(index) ?? null,
    sendChunk: ({ index, isLast }) => sent.push([index, isLast]),
    sendTerminal: () => { terminalCount++ }
  })
  assert.equal(first.nextIndex, 3)
  assert.equal(first.hasSentLast, false)
  assert.deepEqual(sent, [[0, false], [1, false], [2, false]])

  const completed = await streamAppFileChunks({
    startIndex: first.nextIndex,
    totalChunks: 3,
    downloadValidated: true,
    loadChunk: async index => chunks.get(index) ?? null,
    sendChunk: () => assert.fail('no data chunk should remain'),
    sendTerminal: () => { terminalCount++ }
  })
  assert.equal(completed.hasSentLast, true)
  assert.equal(terminalCount, 1)
})
