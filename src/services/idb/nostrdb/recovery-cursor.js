export const RECOVERY_CURSOR_CHUNK_SIZE = 64

function abortError (signal) {
  if (!signal?.aborted) return null
  return signal.reason ?? Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
    code: 'ABORT_ERR'
  })
}

function throwIfAborted (signal) {
  const error = abortError(signal)
  if (error) throw error
}

function comparePrimitiveKeys (left, right) {
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.min(left.length, right.length)
    for (let index = 0; index < length; index++) {
      const compared = comparePrimitiveKeys(left[index], right[index])
      if (compared !== 0) return compared
    }
    return left.length - right.length
  }
  if (typeof left === 'number' && typeof right === 'number') return left - right
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0
  return String(left).localeCompare(String(right))
}

function compareKeys (left, right) {
  try {
    if (typeof globalThis.indexedDB?.cmp === 'function') return globalThis.indexedDB.cmp(left, right)
  } catch {}
  return comparePrimitiveKeys(left, right)
}

function compareCursorPosition (cursor, checkpoint, direction) {
  const indexOrder = compareKeys(cursor.key, checkpoint.indexKey)
  const primaryOrder = indexOrder === 0 ? compareKeys(cursor.primaryKey, checkpoint.primaryKey) : 0
  const order = indexOrder || primaryOrder
  return direction === 'prev' ? -order : order
}

async function scanChunk (db, indexName, range, {
  direction,
  resume,
  limit,
  onStored,
  signal
}) {
  const tx = db.transaction(['events'], 'readonly')
  let onAbort
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve
    tx.onabort = () => reject(tx.error || new Error('recovery cursor transaction aborted'))
    tx.onerror = () => reject(tx.error || new Error('recovery cursor transaction failed'))
  })
  done.catch(() => {})
  if (signal) {
    onAbort = () => {
      try { tx.abort() } catch {}
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    throwIfAborted(signal)
    const state = await new Promise((resolve, reject) => {
      let checkpoint = resume
      let examined = 0
      let matched = 0
      let request

      const fail = error => {
        try { tx.abort() } catch {}
        reject(error)
      }

      try {
        const index = tx.objectStore('events').index(indexName)
        request = index.openCursor(range, direction)
      } catch (error) {
        fail(error)
        return
      }

      request.onsuccess = () => {
        try {
          throwIfAborted(signal)
          const cursor = request.result
          if (!cursor) {
            resolve({ done: true, examined, matched, resume: null })
            return
          }

          if (checkpoint) {
            const position = compareCursorPosition(cursor, checkpoint, direction)
            if (position < 0) {
              cursor.continuePrimaryKey(checkpoint.indexKey, checkpoint.primaryKey)
              return
            }
            checkpoint = null
            if (position === 0) {
              cursor.continue()
              return
            }
          }

          examined++
          if (onStored(cursor.value)) matched++
          if (matched >= limit) {
            resolve({ done: true, examined, matched, resume: null })
            return
          }
          if (examined >= RECOVERY_CURSOR_CHUNK_SIZE) {
            resolve({
              done: false,
              examined,
              matched,
              resume: { indexKey: cursor.key, primaryKey: cursor.primaryKey }
            })
            return
          }
          cursor.continue()
        } catch (error) {
          fail(error)
        }
      }
      request.onerror = () => fail(request.error)
    })
    await done
    return state
  } catch (error) {
    try { tx.abort() } catch {}
    await done.catch(() => {})
    throw abortError(signal) ?? error
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0))

export async function scanRecoveryCursorChunks (db, indexName, range, {
  direction,
  limit,
  scheduleRead,
  signal,
  onStored,
  onChunk = () => {}
} = {}) {
  if (typeof onStored !== 'function') throw new TypeError('INVALID_RECOVERY_CURSOR_ITEM_HANDLER')
  if (!Number.isFinite(limit) || limit <= 0) return { chunks: 0, examined: 0, matched: 0 }

  let resume = null
  let chunkIndex = 0
  let examinedTotal = 0
  let matchedTotal = 0

  while (true) {
    throwIfAborted(signal)
    const startedAt = performance.now()
    const resumed = resume !== null
    const operation = operationSignal => scanChunk(db, indexName, range, {
      direction,
      resume,
      limit: limit - matchedTotal,
      onStored,
      signal: operationSignal
    })
    const chunk = scheduleRead
      ? await scheduleRead(operation)
      : await operation(signal)
    chunkIndex++
    examinedTotal += chunk.examined
    matchedTotal += chunk.matched
    await onChunk({
      chunkIndex,
      examined: chunk.examined,
      matched: chunk.matched,
      resumed,
      done: chunk.done,
      elapsedMs: performance.now() - startedAt
    })
    if (chunk.done || matchedTotal >= limit) break
    resume = chunk.resume
    await yieldToEventLoop()
    throwIfAborted(signal)
  }

  return { chunks: chunkIndex, examined: examinedTotal, matched: matchedTotal }
}
