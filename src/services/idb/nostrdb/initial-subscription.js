// Live is registered before the query. Deduplicate only the overlap already
// queued when the snapshot completes; later sync scores are independent writes.
export function withInitialResults (live, query, pendingCount = () => 0) {
  let snapshot
  let index = 0
  let closed = false
  let initialComplete = false
  let overlap = 0
  let seen
  return {
    [Symbol.asyncIterator] () { return this },
    async next () {
      if (closed) return { done: true }
      try {
        if (!initialComplete) {
          snapshot ??= Promise.resolve().then(query).then(payload => {
            if (closed) return payload
            overlap = pendingCount()
            seen = new Map(payload.results.map((result, i) => [typeof result === 'string' ? result : result.id, payload.meta?.scores?.[i]]))
            return payload
          })
        }
        if (!initialComplete) {
          const { results, meta } = await snapshot
          if (closed) return { done: true }
          if (index < results.length) {
            const result = results[index]
            const value = {
              ...(typeof result === 'string' ? { type: 'id', id: result } : { type: 'event', event: result }),
              meta: { algorithm: meta?.algorithm, sort: meta?.sort, score: meta?.scores?.[index] }
            }
            index++
            return { done: false, value }
          }
          if (overlap === 0) seen = null
          initialComplete = true
          snapshot = null
          return { done: false, value: { type: 'eose' } }
        }
        while (true) {
          const item = await live.next()
          if (closed) return { done: true }
          if (overlap > 0) {
            overlap--
            const { event, id = event?.id, meta } = item.value ?? {}
            const duplicate = seen.has(id) && (meta?.algorithm !== 'sync' || seen.get(id) === meta.score)
            if (overlap === 0) seen = null
            if (duplicate) continue
          } else seen = null
          return item
        }
      } catch (error) { await this.return(); throw error }
    },
    async return () { closed = true; seen = null; snapshot = null; await live.return(); return { done: true } }
  }
}
