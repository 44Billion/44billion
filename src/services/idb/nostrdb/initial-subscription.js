// Register live delivery before taking the snapshot. Overlap is intentional;
// consumers deduplicate by ID. Cancellation also works during a pending query.
export function withInitialResults (live, query) {
  let snapshot
  let index = 0
  let closed = false
  return {
    [Symbol.asyncIterator] () { return this },
    async next () {
      if (closed) return { done: true }
      try {
        snapshot ??= query()
        const { results } = await snapshot
        if (closed) return { done: true }
        if (index < results.length) return { done: false, value: { result: results[index++] } }
        return await live.next()
      } catch (error) { await this.return(); throw error }
    },
    async return () { closed = true; await live.return(); return { done: true } }
  }
}
