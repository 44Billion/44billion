// Helpers for the app-assets caching progress UI (see
// #components/shared/napp-assets-caching-progress-bar.js). Every entry is
// stamped with updatedAt so a stuck "100%" entry can be pruned even when the
// normal completion path (progressCallback's setTimeout) never fires.

import { APP_FILE_CHUNK_BYTES } from '#constants/app-file.js'

export const PROGRESS_VISIBLE_AFTER_COMPLETE_MS = 1000
export const STALE_PROGRESS_MAX_AGE_MS = 5000

export function stampProgressEntry (entry, now = Date.now()) {
  return { ...entry, updatedAt: now }
}

// Applies one app-file caching report and returns whether its data still needs
// to be streamed to the app. Completion of that stream must not suppress the
// final progress report: Blossom intentionally reports its last data event at
// 99% and reports 100% separately after validating the whole file.
export function createAppFileProgressTracker ({
  cachingProgress$,
  filename,
  getTotalChunks,
  setTotalChunks,
  isErrored,
  markErrored,
  isStreamComplete,
  onError,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let completionTimer = null

  const clearCompletionTimer = () => {
    if (completionTimer === null) return
    clearTimer(completionTimer)
    completionTimer = null
  }
  const removeProgress = () => {
    const currentProgress = cachingProgress$()
    const { [filename]: _, ...remaining } = currentProgress
    cachingProgress$(remaining)
  }

  return ({ progress: cachingProgress, total, error }) => {
    if (isErrored()) return false

    if (error) {
      markErrored()
      clearCompletionTimer()
      removeProgress()
      if (!isStreamComplete()) onError(error)
      return false
    }

    let knownTotal = getTotalChunks()
    if (total && knownTotal === null) {
      knownTotal = total
      setTotalChunks(total)
    }
    const currentProgress = cachingProgress$()
    cachingProgress$({
      ...currentProgress,
      [filename]: stampProgressEntry({
        progress: cachingProgress,
        totalByteSizeEstimate: knownTotal ? knownTotal * APP_FILE_CHUNK_BYTES : 0
      })
    })

    if (cachingProgress >= 100) {
      clearCompletionTimer()
      completionTimer = setTimer(() => {
        completionTimer = null
        removeProgress()
      }, PROGRESS_VISIBLE_AFTER_COMPLETE_MS)
    }

    return !isStreamComplete()
  }
}

// Returns a new object with stale completed entries removed; never mutates
// the input. An entry is stale when progress >= 100 and its updatedAt is
// older than maxAge (a missing updatedAt counts as immediately stale).
export function pruneStaleProgressEntries (entries, { now = Date.now(), maxAge = STALE_PROGRESS_MAX_AGE_MS } = {}) {
  const pruned = { ...entries }
  for (const [key, entry] of Object.entries(pruned)) {
    if (typeof entry?.progress !== 'number' || entry.progress < 100) continue
    // A missing updatedAt (legacy/foreign entry) is treated as immediately
    // stale so the sweep can always clean up completed entries.
    const age = entry.updatedAt == null ? Infinity : now - entry.updatedAt
    if (age >= maxAge) delete pruned[key]
  }
  return pruned
}
