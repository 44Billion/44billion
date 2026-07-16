import NMMR from 'nmmr'
import { decode } from 'libp2r2p/base93'
import { APP_FILE_CHUNK_BYTES } from '#constants/app-file.js'

export function parseIrfsChunkEvent (event, { root: expectedRoot } = {}) {
  if (!event || event.kind !== 34601 || !Array.isArray(event.tags) || typeof event.content !== 'string') {
    throw new Error('Wrong IRFS chunk event')
  }
  const dTags = event.tags.filter(tag => Array.isArray(tag) && tag[0] === 'd')
  const mmrTags = event.tags.filter(tag => Array.isArray(tag) && tag[0] === 'mmr')
  if (dTags.length !== 1 || dTags[0].length !== 2 || !/^[0-9a-f]{64}$/.test(dTags[0][1])) {
    throw new Error('Wrong IRFS chunk d tag')
  }
  if (mmrTags.length !== 1 || mmrTags[0].length !== 4) throw new Error('Wrong IRFS chunk mmr tag')

  const [, indexText, totalText, proofText] = mmrTags[0]
  const contentBytes = decode(event.content)
  const proof = decode(proofText)
  const root = NMMR.calculateRoot({ contentBytes, index: indexText, total: totalText, proof })
  const index = Number(indexText)
  const total = Number(totalText)
  if (contentBytes.length < 1 || contentBytes.length > APP_FILE_CHUNK_BYTES ||
      (index < total - 1 && contentBytes.length !== APP_FILE_CHUNK_BYTES)) {
    throw new Error('Wrong IRFS chunk byte length')
  }
  if (expectedRoot && root !== expectedRoot) throw new Error('IRFS chunk root mismatch')
  const d = NMMR.deriveChunkId(root, indexText)
  if (d !== dTags[0][1]) throw new Error('IRFS chunk d tag mismatch')
  return { contentBytes, d, index, proof, root, total }
}

export function parsePseudoBlossomChunkEvent (event, { root } = {}) {
  if (!event || event.kind !== 34601 || !Array.isArray(event.tags) || typeof event.content !== 'string') {
    throw new Error('Wrong local Blossom chunk event')
  }
  const dTags = event.tags.filter(tag => Array.isArray(tag) && tag[0] === 'd')
  const mmrTags = event.tags.filter(tag => Array.isArray(tag) && tag[0] === 'mmr')
  if (dTags.length !== 1 || mmrTags.length !== 1 || mmrTags[0].length !== 4 || mmrTags[0][3] !== '') {
    throw new Error('Wrong local Blossom chunk tags')
  }
  const [, indexText, totalText] = mmrTags[0]
  if (!/^(0|[1-9][0-9]*)$/.test(indexText) || !/^[1-9][0-9]*$/.test(totalText)) {
    throw new Error('Wrong local Blossom chunk position')
  }
  const index = Number(indexText)
  const total = Number(totalText)
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index >= total) {
    throw new Error('Wrong local Blossom chunk position')
  }
  const contentBytes = decode(event.content)
  if (contentBytes.length > APP_FILE_CHUNK_BYTES || (index < total - 1 && contentBytes.length !== APP_FILE_CHUNK_BYTES)) {
    throw new Error('Wrong local Blossom chunk byte length')
  }
  const d = NMMR.deriveChunkId(root, index)
  if (dTags[0][1] !== d) throw new Error('Wrong local Blossom chunk d tag')
  return { contentBytes, d, index, root, total }
}
