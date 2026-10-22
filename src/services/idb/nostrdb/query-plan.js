const MAX_INTERVALS = 16
const SMALL_CANDIDATE = 64
const MAX_KEYS = 256

// Bounded primary-key probes select an access path, never a query result.
// Callers still apply the complete filter, even when a probe found no keys.
export async function selectTagQueryPlan (db, filter, baseline, { tx, tagValueKey, onTiming, scheduleRead, recoveryRead = false, signal } = {}) {
  if (baseline.type !== 'cursor' || !baseline.cursors.length || baseline.cursors.some(cursor => cursor.indexName !== 'byTag')) return baseline
  signal?.throwIfAborted()
  const startedAt = performance.now()
  const makePlan = (name, values) => ({
    type: 'cursor',
    cursors: values.map(value => ({
      indexName: 'byTag',
      range: IDBKeyRange.bound([name, tagValueKey(value), filter.since], [name, tagValueKey(value), filter.until])
    }))
  })
  let probes = 0
  let keysExamined = 0
  let examined = 0
  let earlyDecision = false
  let budgetExhausted = false
  const report = extra => onTiming?.({
    stage: 'query-planning',
    count: probes,
    probes,
    keysExamined,
    examined,
    earlyDecision,
    budgetExhausted,
    elapsedMs: performance.now() - startedAt,
    ...extra
  })

  if (recoveryRead) {
    const preferredTag = filter.tags.find(tag => tag.name === 'o') ?? filter.andTags.find(tag => tag.name === 'o')
    if (!preferredTag) {
      report({ recoveryPlan: true, recoveryPath: 'baseline' })
      return baseline
    }
    const preferred = makePlan('o', preferredTag.values)
    if (preferred.cursors.length > MAX_INTERVALS) {
      budgetExhausted = true
      report({ recoveryPlan: true, recoveryPath: 'baseline' })
      return baseline
    }
    if (preferred.cursors.length !== 1 || baseline.cursors.length !== 1) {
      report({ recoveryPlan: true, recoveryPath: 'o' })
      return preferred
    }
    if (!tx && scheduleRead) {
      return scheduleRead(operationSignal => selectTagQueryPlan(db, filter, baseline, {
        tx: db.transaction(['events'], 'readonly'),
        tagValueKey,
        onTiming,
        scheduleRead,
        recoveryRead: true,
        signal: operationSignal
      }), { preemptible: true })
    }

    const ownTransaction = !tx
    tx ??= db.transaction(['events'], 'readonly')
    let onAbort
    const done = ownTransaction
      ? new Promise((resolve, reject) => {
        tx.addEventListener('complete', resolve, { once: true })
        tx.addEventListener('abort', () => reject(tx.error || new Error('NostrDB recovery planning transaction aborted')), { once: true })
      })
      : Promise.resolve()
    done.catch(() => {})
    if (ownTransaction && signal) {
      onAbort = () => {
        try { tx.abort() } catch {}
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      signal?.throwIfAborted()
      const index = tx.objectStore('events').index('byTag')
      const probe = cursor => new Promise((resolve, reject) => {
        const request = index.getAllKeys(cursor.range, SMALL_CANDIDATE + 1)
        request.onsuccess = () => resolve(request.result.length)
        request.onerror = () => reject(request.error)
      })
      // Queue both requests before waiting for either result.
      const [baselineKeys, preferredKeys] = await Promise.all([
        probe(baseline.cursors[0]),
        probe(preferred.cursors[0])
      ])
      probes = 2
      examined = 2
      keysExamined = baselineKeys + preferredKeys
      if (ownTransaction) await done
      signal?.throwIfAborted()

      const baselineComplete = baselineKeys < SMALL_CANDIDATE + 1
      const preferredComplete = preferredKeys < SMALL_CANDIDATE + 1
      const selected = baselineComplete !== preferredComplete
        ? baselineComplete ? baseline : preferred
        : baselineComplete && baselineKeys < preferredKeys ? baseline : preferred
      earlyDecision = true
      report({
        recoveryPlan: true,
        recoveryPath: selected === preferred ? 'o' : 'baseline',
        recoveryBaselineKeys: baselineKeys,
        recoveryPreferredKeys: preferredKeys,
        recoveryBaselineComplete: baselineComplete,
        recoveryPreferredComplete: preferredComplete
      })
      return selected
    } catch (error) {
      if (ownTransaction) {
        try { tx.abort() } catch {}
        await done.catch(() => {})
      }
      if (signal?.aborted) throw signal.reason
      throw error
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

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
  for (const candidate of candidates) {
    for (const cursor of candidate.cursors) {
      ranges.set(rangeKey(cursor), cursor.range)
      // Preserve the all-or-nothing interval budget, without issuing probes.
      if (ranges.size > MAX_INTERVALS) { budgetExhausted = true; report(); return baseline }
    }
  }
  if (ranges.size <= 1) return baseline
  if (!tx && scheduleRead) {
    return scheduleRead(() => selectTagQueryPlan(db, filter, baseline, {
      tx: db.transaction(['events'], 'readonly'),
      tagValueKey,
      onTiming,
      scheduleRead
    }))
  }
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
