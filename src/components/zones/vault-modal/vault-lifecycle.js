// Vault documents and account updates share one serial generation. A newer
// document can interrupt pending commits, but it never runs beside them.
export function createVaultLifecycleQueue () {
  let generation = 0
  let tail = Promise.resolve()

  const isCurrent = value => value === generation
  const enqueue = (value, task) => {
    const work = tail.catch(() => {}).then(async () => {
      if (!isCurrent(value)) return { generation: value, stale: true }
      const result = await task(() => isCurrent(value))
      return { generation: value, stale: !isCurrent(value), result }
    })
    tail = work
    return work
  }

  return {
    currentGeneration: () => generation,
    advance () {
      const value = ++generation
      return {
        generation: value,
        isCurrent: () => isCurrent(value),
        run: task => enqueue(value, task)
      }
    },
    runCurrent (task) {
      return enqueue(generation, task)
    }
  }
}
