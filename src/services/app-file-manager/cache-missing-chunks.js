import { findRouteFileTag } from '#helpers/app.js'
import { countFileChunksFromDb, streamFileChunksFromDb, saveFileChunksToDB } from '#services/idb/browser/queries/file-chunk.js'
import { getEventsByStrategy } from '#helpers/nostr-queries.js'

export default async function * cacheMissingChunks (appId, bundle, filename, fileTag) {
  fileTag ??= findRouteFileTag(filename, bundle.tags)
  if (!fileTag) throw new Error(`No matching file tag found for path: ${filename}`)

  const fileRootHash = fileTag[1]
  const chunkStatus = await countFileChunksFromDb(fileRootHash)
  const isCached = chunkStatus.count === chunkStatus.total
  if (isCached) { return yield 100 }

  const getProgress = chunkStatus => Math.floor(chunkStatus.count / chunkStatus.total * 100)
  yield getProgress(chunkStatus)

  const storedChunkPositions = {}
  for await (const storedChunkKey of streamFileChunksFromDb(appId, fileRootHash, { justKeys: true })) {
    storedChunkPositions[storedChunkKey[2]] = true
  }
  const pubkeyHints = [fileTag[4]?.trim(), bundle.pubkey].filter(Boolean)
  const missingChunkPositions = [...Array(chunkStatus.total).keys()].filter(pos => !storedChunkPositions[pos])
  const newlyStoredChunksLength = yield * getAndCacheMissingChunks(missingChunkPositions, pubkeyHints, bundle, appId, chunkStatus)

  if ((newlyStoredChunksLength + chunkStatus.count) < chunkStatus.total) {
    throw new Error('Some chunks are missing')
  }
}

async function * getAndCacheMissingChunks (missingChunkPositions, pubkeyHints, bundle, appId, chunkStatus) {
  let storedChunksLength = 0

  const getProgress = () =>
    Math.floor((chunkStatus.count + storedChunksLength) / chunkStatus.total * 100)

  // batches of 4
  for (let i = 0; i < missingChunkPositions.length; i += 4) {
    const batch = missingChunkPositions.slice(i, i + 4)
    let attempts = 0
    let success = false
    while (!success && attempts < 20) {
      const filter = {
        authors: pubkeyHints,
        '#c': batch,
        limit: batch.length
      }
      const chunks = await getEventsByStrategy(filter, { code: 'WRITE_RELAYS' })
      if (chunks) {
        success = true
        if (chunks.length > 0) {
          await saveFileChunksToDB(bundle, chunks, appId)
          storedChunksLength += chunks.length
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
      return
    }
  }
}
