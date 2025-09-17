import { findRouteFileTag } from '#helpers/app.js'
import { countFileChunksFromDb, deleteFileChunksFromDb, streamFileChunksFromDb, saveFileChunksToDB } from '#services/idb/browser/queries/file-chunk.js'
import { getEventsByStrategy } from '#helpers/nostr-queries.js'

export default async function * cacheMissingChunks (appId, bundle, filename, fileTag) {
  fileTag ??= findRouteFileTag(filename, bundle.tags)
  if (!fileTag) throw new Error(`No matching file tag found for path: ${filename}`)

  const fileRootHash = fileTag[1]
  let chunkStatus = await countFileChunksFromDb(appId, fileRootHash)
  const isCached = chunkStatus.count === chunkStatus.total
  if (isCached) { yield 100; return }
  const pubkeyHints = [fileTag[4]?.trim(), bundle.pubkey].filter(Boolean)
  // don't know which chunks are missing
  if (!chunkStatus.total) {
    // Delete faulty chunks (no chunkStatus.total means their c tags are incomplete)
    // to give author a chance to update them
    if (chunkStatus.count) {
      await deleteFileChunksFromDb(appId, fileRootHash)
      chunkStatus.count = 0
    }
    chunkStatus = yield * getAndCacheMissingChunks(fileRootHash, [0, 1, 2, 3], pubkeyHints, bundle, appId, chunkStatus)
    if (!chunkStatus.total) throw new Error('Some chunks are missing')
  }

  const storedChunkPositions = {}
  for await (const storedChunkKey of streamFileChunksFromDb(appId, fileRootHash, { justKeys: true })) {
    storedChunkPositions[storedChunkKey[2]] = true
  }
  // [...Array(chunkStatus.total).keys()] would be [0] if chunkStatus.total=null
  const missingChunkPositions = [...Array(chunkStatus.total).keys()].filter(pos => !storedChunkPositions[pos])
  chunkStatus = yield * getAndCacheMissingChunks(fileRootHash, missingChunkPositions, pubkeyHints, bundle, appId, chunkStatus)

  if (!chunkStatus.total || chunkStatus.count < chunkStatus.total) {
    throw new Error('Some chunks are missing')
  }
}

async function * getAndCacheMissingChunks (fileRootHash, missingChunkPositions, pubkeyHints, bundle, appId, chunkStatus) {
  let newlyStoredChunksLength = 0
  let total = chunkStatus.total

  const getProgress = () =>
    Math.floor((chunkStatus.count + newlyStoredChunksLength) / total * 100)

  // batches of 4
  for (let i = 0; i < missingChunkPositions.length; i += 4) {
    const batch = missingChunkPositions.slice(i, i + 4)
    let attempts = 0
    let success = false
    while (!success && attempts < 20) {
      const filter = {
        authors: pubkeyHints,
        '#c': batch.map(pos => `${fileRootHash}:${pos}`),
        limit: batch.length
      }
      const chunks = await getEventsByStrategy(filter, { code: 'WRITE_RELAYS', maxRelaysPerUser: 7 })
      if (chunks) {
        success = true
        if (chunks.length > 0) {
          await saveFileChunksToDB(bundle, chunks, appId)
          newlyStoredChunksLength += chunks.length
          if (!total) {
            for (const chunk of chunks) {
              if ((total = getNumberOfChunks(chunk, fileRootHash))) break
            }
          }
          if (!total) continue
          yield getProgress()
        }
      } else {
        attempts++
        console.log(`Failed to fetch chunks (${attempts}). Retrying...`)
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, Math.min(10, attempts)) * 1000))
      }
    }
    if (!success) {
      console.log('Failed to fetch chunks after multiple retries')
      break
    }
  }

  return { count: chunkStatus.count + newlyStoredChunksLength, total }
}

function getNumberOfChunks (chunk, rootHash) {
  const cTag = chunk.tags.find(t => t[0] === 'c' && t[1].startsWith(`${rootHash}:`))
  if (!cTag) return null
  const parsedTotal = parseInt(cTag[2])
  if (Number.isNaN(parsedTotal)) return null
  if (parsedTotal > 0) return parsedTotal
}
