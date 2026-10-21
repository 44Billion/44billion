export const ACCOUNT_COVERAGE_BATCH_MS = 50

export function createAccountCoverageCheckpointQueue ({
  signal,
  delay = ACCOUNT_COVERAGE_BATCH_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  const groups = new Map()
  let timer = null
  let running = Promise.resolve()
  let failure = null
  let stopped = false

  const hasPending = () => [...groups.values()].some(group => group.requests.length)
  function take () {
    const jobs = []
    for (const [coverage, group] of groups) {
      const requests = group.requests.splice(0).filter(request => !request?.signal?.aborted)
      if (!requests.length) {
        groups.delete(coverage)
        continue
      }
      jobs.push({ coverage, requests })
    }
    return jobs
  }
  function schedule () {
    if (stopped || signal?.aborted || timer || !hasPending()) return
    timer = setTimer(() => {
      timer = null
      drain().catch(() => {})
    }, delay)
    timer?.unref?.()
  }
  function drain () {
    if (stopped || signal?.aborted) {
      groups.clear()
      return running
    }
    const jobs = take()
    if (!jobs.length) return running
    running = running.then(async () => {
      const results = await Promise.allSettled(jobs.map(job => job.coverage.markBatch(job.requests, signal)))
      const rejected = results.find(result => result.status === 'rejected')
      if (rejected && !failure) failure = rejected.reason
      if (hasPending()) schedule()
    })
    return running
  }

  return {
    queue (coverage, request) {
      if (stopped || signal?.aborted || request?.signal?.aborted) return
      let group = groups.get(coverage)
      if (!group) {
        group = { requests: [] }
        groups.set(coverage, group)
      }
      group.requests.push(request)
      schedule()
    },
    async flush () {
      if (timer) {
        clearTimer(timer)
        timer = null
      }
      while (true) {
        if (stopped || signal?.aborted) break
        drain()
        await running
        if (!hasPending()) break
      }
      if (failure) {
        const error = failure
        failure = null
        throw error
      }
    },
    stop () {
      stopped = true
      if (timer) clearTimer(timer)
      timer = null
      groups.clear()
    }
  }
}
