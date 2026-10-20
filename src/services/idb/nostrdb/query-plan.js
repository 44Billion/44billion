const MAX_INTERVALS = 16
const SMALL_CANDIDATE = 64
const MAX_KEYS = 256

// Bounded primary-key probes select an access path, never a query result.
// Callers still apply the complete filter, even when a probe found no keys.
export async function selectTagQueryPlan (db, filter, baseline, { tx, tagValueKey, onTiming } = {}) {
  if (baseline.type !== 'cursor' || !baseline.cursors.length || baseline.cursors.some(cursor => cursor.indexName !== 'byTag')) return baseline
  const startedAt = performance.now()
  const makePlan = (name, values) => ({
    type: 'cursor',
    cursors: values.map(value => ({
      indexName: 'byTag',
      range: IDBKeyRange.bound([name, tagValueKey(value), filter.since], [name, tagValueKey(value), filter.until])
    }))
  })
  const candidates = [baseline]
  for (const tag of filter.andTags) {
    for (const value of tag.values) candidates.push(makePlan(tag.name, [value]))
  }
  const personalCopies = filter.kinds?.length === 1 && filter.kinds[0] === 1006
  if (personalCopies) {
    for (const tag of filter.tags) if (tag.name === 'o') candidates.push(makePlan(tag.name, tag.values))
  }
  for (const tag of filter.tags) {
    if (!personalCopies || tag.name !== 'o') candidates.push(makePlan(tag.name, tag.values))
  }
  const rangeKey = ({ range }) => JSON.stringify([range.lower, range.upper, range.lowerOpen, range.upperOpen])
  const ranges = new Map()
  let probes = 0
  let keysExamined = 0
  let examined = 0
  let earlyDecision = false
  let budgetExhausted = false
  const report = () => onTiming?.({ stage: 'query-planning', count: probes, probes, keysExamined, examined, earlyDecision, budgetExhausted, elapsedMs: performance.now() - startedAt })
  for (const candidate of candidates) {
    for (const cursor of candidate.cursors) {
      ranges.set(rangeKey(cursor), cursor.range)
      // Preserve the all-or-nothing interval budget, without issuing probes.
      if (ranges.size > MAX_INTERVALS) { budgetExhausted = true; report(); return baseline }
    }
  }
  if (ranges.size <= 1) return baseline
  const ownTransaction = !tx
  tx ??= db.transaction(['events'], 'readonly')
  const done = ownTransaction
    ? new Promise((resolve, reject) => {
      tx.addEventListener('complete', resolve, { once: true })
      tx.addEventListener('abort', () => reject(tx.error || new Error('NostrDB planning transaction aborted')), { once: true })
    })
    : null
  // Observe aborts immediately, including when a request fails first.
  done?.catch(() => {})
  try {
    const index = tx.objectStore('events').index('byTag')
    const samples = new Map()
    let selected = baseline
    for (const candidate of candidates) {
      examined++
      let complete = true
      let size = 0
      for (const cursor of candidate.cursors) {
        const key = rangeKey(cursor)
        let sample = samples.get(key)
        if (!sample) {
          const limit = Math.min(SMALL_CANDIDATE + 1, MAX_KEYS - keysExamined)
          if (limit === 0) { budgetExhausted = true; complete = false; break }
          // Only IDB requests are awaited while this transaction is live.
          const length = await new Promise((resolve, reject) => {
            const request = index.getAllKeys(cursor.range, limit)
            request.onsuccess = () => resolve(request.result.length)
            request.onerror = () => reject(request.error)
          })
          probes++
          keysExamined += length
          sample = { length, complete: length < limit }
          samples.set(key, sample)
        }
        size += sample.length
        // An unfinished OR candidate is never treated as an empty/small set.
        if (!sample.complete || size > SMALL_CANDIDATE) { complete = false; break }
      }
      if (complete) { selected = candidate; earlyDecision = true; break }
      if (budgetExhausted) break
    }
    budgetExhausted ||= keysExamined === MAX_KEYS
    if (ownTransaction) await done
    report()
    return selected
  } catch (error) {
    // Never abort a caller's transaction: its owner handles rollback.
    if (ownTransaction) {
      try { tx.abort() } catch {}
      await done.catch(() => {})
    }
    throw error
  }
}
