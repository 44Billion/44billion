import { run } from '#services/idb/browser/index.js'
import { addressObjToAppId } from '#helpers/app.js'

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
  while ((res = await p.promise) && (cursor = res.result)) {
    if (signal?.aborted) { res.tx.abort(); break }

    if (!allowed.has(cursor.value.fx)) {
      cursor.delete()
    } else {
      continueKey = getContinueKey(cursor)
    }
    Object.assign(p, Promise.withResolvers())
    cursor.continue(continueKey)
    if (continueKey) continueKey = undefined
  }
}

// Caution: when there's no rootHash arg, use this only when no user has the app installed anymore
export async function deleteFileChunksFromDb (appId, rootHash) {
  if (!appId) throw new Error('Missing bundle id')

  const range = IDBKeyRange.bound([appId, rootHash ?? '\u0000', -Infinity], [appId, rootHash ?? '\uffff', Infinity])
  return run('delete', [range], 'fileChunks').then(v => v.result)
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

export async function saveFileChunksToDB (bundle, fileChunks, appId) {
  const bundleRootHashesObj = bundle.tags
    .filter(t => t[0] === 'file' && !!t[1])
    .map(t => t[1])
    .reduce((r, v) => ({ ...r, [v]: true }), {})

  let ret
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
        if (chunkPosition !== undefined && bundleRootHashesObj[fileRootHash]) {
          formatedCTags.push([fileRootHash, parseInt(chunkPosition)])
        }
      }
    }

    appId ??= addressObjToAppId({
      kind: bundle.kind,
      pubkey: bundle.pubkey,
      dTag: bundle.tags.find(t => t[0] === 'd')[1]
    })

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
      ret = await run('put', [chunk], 'fileChunks', null, ret)
    }
  }
}
