// Counts index entries, never event payloads. Estimates select an access path;
// callers must still apply the complete filter to every fetched candidate.
export async function selectTagQueryPlan (db, filter, baseline, { tx, tagValueKey, onTiming } = {}) {
  if (baseline.type !== 'cursor' || !baseline.cursors.length || baseline.cursors.some(cursor => cursor.indexName !== 'byTag')) return baseline
  const startedAt = performance.now()
  const candidates = [baseline]
  const makePlan = (name, values) => ({
    type: 'cursor',
    cursors: values.map(value => ({
      indexName: 'byTag',
      range: IDBKeyRange.bound([name, tagValueKey(value), filter.since], [name, tagValueKey(value), filter.until])
    }))
  })
  for (const tag of filter.tags) candidates.push(makePlan(tag.name, tag.values))
  for (const tag of filter.andTags) {
    for (const value of tag.values) candidates.push(makePlan(tag.name, [value]))
  }
  const rangeKey = ({ range }) => JSON.stringify([range.lower, range.upper, range.lowerOpen, range.upperOpen])
  const ranges = new Map()
  for (const candidate of candidates) {
    for (const cursor of candidate.cursors) {
      ranges.set(rangeKey(cursor), cursor.range)
      // All-or-nothing budget: no partial estimates for large OR groups.
      if (ranges.size > 16) { onTiming?.({ stage: 'query-planning', count: 0, examined: candidates.length, elapsedMs: performance.now() - startedAt }); return baseline }
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
  const index = tx.objectStore('events').index('byTag')
  const work = Promise.all([...ranges].map(([key, range]) => new Promise((resolve, reject) => {
    const request = index.count(range)
    request.onsuccess = () => resolve([key, request.result])
    request.onerror = () => reject(request.error)
  })))
  const counts = new Map(ownTransaction ? (await Promise.all([work, done]))[0] : await work)
  let selected = baseline
  let best = Infinity
  for (const candidate of candidates) {
    const estimate = candidate.cursors.reduce((sum, cursor) => sum + counts.get(rangeKey(cursor)), 0)
    // Baseline is first, followed by original filter order. Strict comparison
    // preserves that order on ties. OR sums may overestimate shared matches.
    if (estimate < best) { best = estimate; selected = candidate }
  }
  onTiming?.({ stage: 'query-planning', count: ranges.size, examined: candidates.length, elapsedMs: performance.now() - startedAt })
  return selected
}
