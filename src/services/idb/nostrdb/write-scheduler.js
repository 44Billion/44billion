import { recordPerformance } from '#services/performance-diagnostics.js'

const CLASS_RANK = Object.freeze({
  maintenance: 0,
  background: 1,
  normal: 2,
  foreground: 3
})
const CLASS_ORDER = Object.freeze(['foreground', 'normal', 'background', 'maintenance'])
const CLASS_STARVATION_LIMIT = 3
const schedulers = new Map()

function normalizeClass (value) {
  return Object.hasOwn(CLASS_RANK, value) ? value : 'normal'
}

function normalizeStores (stores) {
  if (!Array.isArray(stores) || stores.length === 0 || stores.some(store => typeof store !== 'string' || !store)) {
    throw new TypeError('INVALID_NOSTRDB_SCHEDULER_STORES')
  }
  return [...new Set(stores)].sort()
}

function intersects (left, right) {
  return left.some(store => right.includes(store))
}

function createScheduler () {
  const queues = new Map()
  const consumers = new Map()
  const cursors = new Map()
  const active = new Set()
  let preferred = 0
  let pumping = false
  let waiting = 0

  function consumerQueue (className, consumerId) {
    let byConsumer = queues.get(className)
    if (!byConsumer) {
      byConsumer = new Map()
      queues.set(className, byConsumer)
    }
    let queue = byConsumer.get(consumerId)
    if (!queue) {
      queue = []
      byConsumer.set(consumerId, queue)
      let order = consumers.get(className)
      if (!order) {
        order = []
        consumers.set(className, order)
      }
      order.push(consumerId)
    }
    return queue
  }

  function removeEmptyConsumer (className, consumerId) {
    const byConsumer = queues.get(className)
    const queue = byConsumer?.get(consumerId)
    if (!byConsumer || queue?.length) return
    byConsumer.delete(consumerId)
    const order = consumers.get(className)
    const index = order?.indexOf(consumerId) ?? -1
    if (index !== -1) order.splice(index, 1)
    const cursor = cursors.get(className) || 0
    if (index !== -1 && index < cursor) cursors.set(className, Math.max(0, cursor - 1))
  }

  function removeJob (job) {
    const byConsumer = queues.get(job.schedulerClass)
    const queue = byConsumer?.get(job.consumerId)
    const index = queue?.indexOf(job) ?? -1
    if (index === -1) return false
    queue.splice(index, 1)
    waiting--
    removeEmptyConsumer(job.schedulerClass, job.consumerId)
    return true
  }

  function activeStores () {
    const stores = []
    for (const job of active) stores.push(...job.stores)
    return stores
  }

  function runnable (job, occupied) {
    return !intersects(job.stores, occupied)
  }

  function takeFromClass (className, occupied) {
    const byConsumer = queues.get(className)
    const order = consumers.get(className)
    if (!byConsumer || !order?.length) return null
    let cursor = (cursors.get(className) || 0) % order.length
    for (let checked = 0; checked < order.length; checked++) {
      const consumerId = order[cursor]
      const queue = byConsumer.get(consumerId)
      const job = queue?.[0]
      if (job && runnable(job, occupied)) {
        queue.shift()
        waiting--
        if (!queue.length) removeEmptyConsumer(className, consumerId)
        else cursors.set(className, (cursor + 1) % order.length)
        return job
      }
      cursor = (cursor + 1) % order.length
    }
    return null
  }

  function take (occupied) {
    if (preferred >= CLASS_STARVATION_LIMIT) {
      for (const className of ['background', 'maintenance']) {
        const job = takeFromClass(className, occupied)
        if (job) {
          preferred = 0
          return job
        }
      }
    }
    for (const className of CLASS_ORDER) {
      const job = takeFromClass(className, occupied)
      if (!job) continue
      preferred = CLASS_RANK[className] >= CLASS_RANK.normal ? preferred + 1 : 0
      return job
    }
    return null
  }

  function start (job) {
    job.startedAt = performance.now()
    active.add(job)
    recordPerformance({
      stage: 'scheduler-wait',
      schedulerClass: job.schedulerClass,
      schedulerWaitMs: job.startedAt - job.queuedAt,
      schedulerActive: active.size,
      schedulerWaiting: waiting,
      storeCount: job.stores.length,
      schedulerConflict: job.conflict
    })
    recordPerformance({
      stage: 'nostrdb-scheduler-start',
      schedulerClass: job.schedulerClass,
      schedulerWaitMs: job.startedAt - job.queuedAt,
      schedulerActive: active.size,
      schedulerWaiting: waiting,
      storeCount: job.stores.length,
      schedulerConflict: job.conflict
    })
    Promise.resolve()
      .then(job.operation)
      .then(job.resolve, job.reject)
      .finally(() => {
        active.delete(job)
        recordPerformance({
          stage: 'nostrdb-scheduler-complete',
          schedulerClass: job.schedulerClass,
          schedulerActive: active.size,
          schedulerWaiting: waiting,
          storeCount: job.stores.length
        })
        pump()
      })
  }

  function pump () {
    if (pumping) return
    pumping = true
    try {
      while (true) {
        const occupied = activeStores()
        const job = take(occupied)
        if (!job) break
        start(job)
      }
    } finally {
      pumping = false
    }
  }

  return {
    run (job) {
      job.conflict = active.size > 0 && !runnable(job, activeStores())
      consumerQueue(job.schedulerClass, job.consumerId).push(job)
      waiting++
      pump()
    },
    remove: removeJob,
    cancelWaiting (error) {
      let cancelled = 0
      for (const byConsumer of queues.values()) {
        for (const queue of byConsumer.values()) {
          for (const job of queue.splice(0)) {
            waiting--
            cancelled++
            job.reject(error)
          }
        }
      }
      queues.clear()
      consumers.clear()
      cursors.clear()
      return cancelled
    },
    snapshot: () => ({ active: active.size, waiting })
  }
}

function schedulerFor (owner) {
  let scheduler = schedulers.get(owner)
  if (!scheduler) {
    scheduler = createScheduler()
    schedulers.set(owner, scheduler)
  }
  return scheduler
}

export function scheduleNostrDbWrite ({
  owner,
  stores,
  schedulerClass = 'normal',
  appId = 'system',
  signal,
  assertCurrent
}, operation) {
  if (typeof owner !== 'string' || !owner) return Promise.reject(new TypeError('INVALID_NOSTRDB_SCHEDULER_OWNER'))
  if (typeof operation !== 'function') return Promise.reject(new TypeError('INVALID_NOSTRDB_SCHEDULER_OPERATION'))
  signal?.throwIfAborted()
  const scheduler = schedulerFor(owner)
  let job
  const scheduled = new Promise((resolve, reject) => {
    job = {
      stores: normalizeStores(stores),
      schedulerClass: normalizeClass(schedulerClass),
      consumerId: `${appId || 'system'}`,
      operation: async () => {
        assertCurrent?.()
        return operation()
      },
      queuedAt: performance.now(),
      resolve,
      reject,
      signal,
      abort: null
    }
    if (signal) {
      job.abort = () => {
        if (scheduler.remove(job)) reject(abortReason(signal))
      }
      signal.addEventListener('abort', job.abort, { once: true })
    }
    scheduler.run(job)
  })
  return scheduled.finally(() => {
    if (signal && job?.abort) signal.removeEventListener('abort', job.abort)
    const snapshot = scheduler.snapshot()
    if (snapshot.active === 0 && snapshot.waiting === 0) schedulers.delete(owner)
  })
}

export function nostrDbWriteSchedulerSnapshot (owner) {
  return schedulers.get(owner)?.snapshot() ?? { active: 0, waiting: 0 }
}

export function cancelNostrDbWrites (owner, error = resetError()) {
  const scheduler = schedulers.get(owner)
  if (!scheduler) return 0
  const cancelled = scheduler.cancelWaiting(error)
  const snapshot = scheduler.snapshot()
  if (snapshot.active === 0 && snapshot.waiting === 0) schedulers.delete(owner)
  return cancelled
}

export function clearNostrDbWriteSchedulers () {
  schedulers.clear()
}

function abortReason (signal) {
  if (signal.reason !== undefined) return signal.reason
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
}

function resetError () {
  return Object.assign(new Error('NOSTRDB_RESET'), { code: 'NOSTRDB_RESET' })
}
