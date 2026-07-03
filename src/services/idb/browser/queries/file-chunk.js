import { run } from '#services/idb/browser/index.js'
import { addressObjToAppId } from '#helpers/app.js'
import { APP_FILE_CHUNK_BYTES } from '#constants/app-file.js'
import {
  applyAssetBudgetDelta,
  ensureAssetBudgetInitialized,
  ensureCanStoreAppAssetBytes
} from '#services/app-asset-budget/index.js'

export async function countFileChunksFromDb (appId, rootHash) {
  let total = null
  for await (const storedChunk of streamFileChunksFromDb(appId, rootHash)) {
    const cTag = storedChunk.evt.tags.find(t => t[0] === 'c' && t[1].startsWith(`${rootHash}:`))
    if (!cTag) continue
    const parsedTotal = parseInt(cTag[2])
    if (Number.isNaN(parsedTotal)) continue
    if (parsedTotal > 0) { total = parsedTotal; break }
  }
  if (!total) return { count: 0, total }

  const range = IDBKeyRange.bound([appId, rootHash, -Infinity], [appId, rootHash, Infinity])
  return run('count', [range], 'fileChunks').then(v => ({ count: v.result, total }))
}

export async function deleteStaleFileChunksFromDb (appId, allowedRootHashes, { signal } = {}) {
  await ensureAssetBudgetInitialized({ appId, _countFileChunksForApp: countFileChunkRowsFromDb })
  const allowed = new Set(allowedRootHashes)
  const p = Promise.withResolvers()
  const range = IDBKeyRange.bound([appId, '\u0000', -Infinity], [appId, '\uffff', Infinity])
  run('openCursor', [range], 'fileChunks', null, { p })

  const getContinueKey = cursor => {
    const [, rootHash] = cursor.key
    return [appId, rootHash, Infinity]
  }
  let cursor
  let continueKey
  let res
  let deletedCount = 0
  while ((res = await p.promise) && (cursor = res.result)) {
    if (signal?.aborted) { res.tx.abort(); break }

    if (!allowed.has(cursor.value.fx)) {
      deletedCount++
      cursor.delete()
    } else {
      continueKey = getContinueKey(cursor)
    }
    Object.assign(p, Promise.withResolvers())
    cursor.continue(continueKey)
    if (continueKey) continueKey = undefined
  }
  if (deletedCount > 0 && !signal?.aborted) applyAssetBudgetDelta(-(deletedCount * APP_FILE_CHUNK_BYTES), { appId })
}

// Caution: when there's no rootHash arg, use this only when no user has the app installed anymore
export async function deleteFileChunksFromDb (appId, rootHash) {
  if (!appId) throw new Error('Missing app id')
  await ensureAssetBudgetInitialized({ appId, _countFileChunksForApp: countFileChunkRowsFromDb })

  const range = IDBKeyRange.bound([appId, rootHash ?? '\u0000', -Infinity], [appId, rootHash ?? '\uffff', Infinity])
  const p = Promise.withResolvers()
  await run('openCursor', [range], 'fileChunks', null, { p })

  let cursor
  let deletedCount = 0
  while ((cursor = (await p.promise).result)) {
    deletedCount++
    cursor.delete()
    Object.assign(p, Promise.withResolvers())
    cursor.continue()
  }
  if (deletedCount > 0) applyAssetBudgetDelta(-(deletedCount * APP_FILE_CHUNK_BYTES), { appId })
}

export async function getFileChunksFromDb (appId, rootHash, { fromPos, toPos, justKeys = false } = {}) {
  const lowerBound = fromPos !== undefined ? fromPos : -Infinity
  const upperBound = toPos !== undefined ? toPos : Infinity
  const range = IDBKeyRange.bound([appId, rootHash, lowerBound], [appId, rootHash, upperBound])

  return run(justKeys ? 'getAllKeys' : 'getAll', [range], 'fileChunks').then(v => v.result)
}

export async function * streamFileChunksFromDb (appId, rootHash, { fromPos, toPos, justKeys = false } = {}) {
  const lowerBound = fromPos !== undefined ? fromPos : -Infinity
  const upperBound = toPos !== undefined ? toPos : Infinity
  const range = IDBKeyRange.bound([appId, rootHash, lowerBound], [appId, rootHash, upperBound])

  const p = Promise.withResolvers()
  await run(justKeys ? 'openKeyCursor' : 'openCursor', [range], 'fileChunks', null, { p })
  const field = justKeys ? 'key' : 'value'

  let cursor
  while ((cursor = (await p.promise).result)) {
    yield cursor[field]
    Object.assign(p, Promise.withResolvers())
    cursor.continue()
  }
}

async function countFileChunkRowsFromDb (appId, rootHash) {
  const range = IDBKeyRange.bound([appId, rootHash ?? '\u0000', -Infinity], [appId, rootHash ?? '\uffff', Infinity])
  return run('count', [range], 'fileChunks').then(v => v.result)
}

export async function sumFileChunkBytesFromDb (appId, rootHashes = null) {
  await ensureAssetBudgetInitialized({ appId, _countFileChunksForApp: countFileChunkRowsFromDb })
  if (!rootHashes) return (await countFileChunkRowsFromDb(appId)) * APP_FILE_CHUNK_BYTES

  let count = 0
  for (const rootHash of new Set(rootHashes)) {
    count += await countFileChunkRowsFromDb(appId, rootHash)
  }
  return count * APP_FILE_CHUNK_BYTES
}

export async function saveFileChunksToDB (siteManifest, fileChunks, appId, {
  assetBudget = {},
  _applyAssetBudgetDelta = applyAssetBudgetDelta,
  _ensureCanStoreAppAssetBytes = ensureCanStoreAppAssetBytes
} = {}) {
  appId ??= addressObjToAppId({
    kind: siteManifest.kind,
    pubkey: siteManifest.pubkey,
    dTag: siteManifest.tags.find(t => t[0] === 'd')?.[1] ?? ''
  })
  await ensureAssetBudgetInitialized({ appId, _countFileChunksForApp: countFileChunkRowsFromDb })
  const manifestRootHashesObj = siteManifest.tags
    .filter(t => t[0] === 'path' && !!t[2])
    .map(t => t[2])
    .reduce((r, v) => ({ ...r, [v]: true }), {})

  for (const chunkEvent of fileChunks) {
    if (chunkEvent.kind !== 34600) throw new Error('Wrong chunk kind')
    let dTag
    const formatedCTags = []
    for (const tag of chunkEvent.tags) {
      if (tag[0] === 'd') dTag = tag
      // Although rare,
      // a chunk can have many c tags by being a chunk that
      // appears on 2+ files (2 fileRootHashes) at same or different positions
      // or appears twice+ on same file at different positions
      if (tag[0] === 'c') {
        const [fileRootHash, chunkPosition] = tag[1].split(':')
        if (chunkPosition !== undefined && manifestRootHashesObj[fileRootHash]) {
          formatedCTags.push([fileRootHash, parseInt(chunkPosition)])
        }
      }
    }
    for (const [fileRootHash, chunkPosition] of formatedCTags) {
      const chunk = {
        appId,
        x: dTag[1],
        fx: fileRootHash,
        pos: chunkPosition,
        // We're not caring about normalizing the chunk.evt to a separate store
        // because this loop rarely has more than 1 iteration
        // In fact, the most space preserving structure would be chunk.x as store keypath
        // but it is rare to share file chunks across different files or apps
        evt: chunkEvent
      }
      const key = [appId, fileRootHash, chunkPosition]
      const old = (await run('get', [key], 'fileChunks')).result
      const deltaBytes = old ? 0 : APP_FILE_CHUNK_BYTES
      if (deltaBytes > 0) {
        await _ensureCanStoreAppAssetBytes(deltaBytes, {
          ...assetBudget,
          appId
        })
        if (assetBudget.replacement) assetBudget.replacement.newBytes += deltaBytes
      }

      await run('put', [chunk], 'fileChunks')
      if (deltaBytes !== 0) _applyAssetBudgetDelta(deltaBytes, { appId })
    }
  }
}
