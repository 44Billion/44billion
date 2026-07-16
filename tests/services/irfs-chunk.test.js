import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import NMMR from 'nmmr'
import { encode } from 'libp2r2p/base93'
import { parseIrfsChunkEvent, parsePseudoBlossomChunkEvent } from '#services/irfs-chunk.js'

async function fixture () {
  const mmr = new NMMR()
  await mmr.append(new Uint8Array(51000).fill(1))
  await mmr.append(Uint8Array.of(2, 3))
  const root = mmr.getRoot()
  const chunks = await Array.fromAsync(mmr.getChunks())
  return {
    mmr,
    events: chunks.map(chunk => ({
      kind: 34601,
      tags: [['d', NMMR.deriveChunkId(root, chunk.index)], ['mmr', String(chunk.index), String(chunk.total), encode(chunk.proof)]],
      content: encode(chunk.contentBytes)
    }))
  }
}

describe('IRFS chunk validation', () => {
  it('authenticates content, index, total, proof, root and d', async () => {
    const { mmr, events } = await fixture()
    const parsed = events.map(event => parseIrfsChunkEvent(event, { root: mmr.getRoot() }))
    assert.deepEqual(parsed.map(chunk => chunk.index), [0, 1])
  })

  it('rejects mutations but ignores an incorrect size hint', async () => {
    const { mmr, events } = await fixture()
    const mutated = structuredClone(events[1])
    mutated.content = encode(Uint8Array.of(9))
    assert.throws(() => parseIrfsChunkEvent(mutated, { root: mmr.getRoot() }), /root|mismatch/)
    assert.equal(parseIrfsChunkEvent(events[1], { root: mmr.getRoot(), size: 51003 }).index, 1)
  })

  it('validates local Blossom pseudo chunks without treating the empty proof as an MMR proof', () => {
    const root = 'f'.repeat(64)
    const event = {
      kind: 34601,
      tags: [['d', NMMR.deriveChunkId(root, 0)], ['mmr', '0', '1', '']],
      content: encode(Uint8Array.of(1, 2))
    }
    assert.equal(parsePseudoBlossomChunkEvent(event, { root, size: 999 }).index, 0)
    assert.throws(() => parseIrfsChunkEvent(event, { root }), /proof|root|mismatch/)
  })
})
