// Helpers for the app-assets caching progress UI (see
// #components/shared/napp-assets-caching-progress-bar.js). Every entry is
// stamped with updatedAt so a stuck "100%" entry can be pruned even when the
// normal completion path (progressCallback's setTimeout) never fires.

export const PROGRESS_VISIBLE_AFTER_COMPLETE_MS = 1000
export const STALE_PROGRESS_MAX_AGE_MS = 5000

export function stampProgressEntry (entry, now = Date.now()) {
  return { ...entry, updatedAt: now }
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
