/*
When subscribe(..., { scheduled: true }) is used, index.js still owns the
subscription queue and result wrapping. This module only owns the delayed
delivery clock.

Behind the scenes:
- future durable events that match a subscription are not queued immediately;
  they only arm a single timer for that subscription, or move it earlier when
  a newly added matching event is due sooner than the current timer;
- when the timer fires, the scheduler rescans events.byCreatedAt for rows that
  are now due, rechecks that each stored row is still live and still matches,
  then asks index.js to emit the row;
- already-persisted future rows are discovered by the same index scan when the
  subscription starts, so no in-memory payload queue can leak replaced/deleted
  events;
- regular and honorary ephemeral events are never delayed because they are not
  durable scheduled rows.
*/
export const SCHEDULED_EVENT_SKEW = 2

const SCHEDULED_DELIVERY_BATCH_SIZE = 64
// setTimeout delays are commonly clamped to a signed 32-bit integer.
// Far-future events re-arm after this safe maximum instead of overflowing.
const MAX_SCHEDULED_TIMEOUT_MS = 0x7fffffff

// Scheduled delivery is active-subscription state only. It arms one timer,
// rescans IndexedDB when due, and lets index.js own queueing and result shape.
export function createScheduledDelivery ({
  openDb,
  scanCreatedAt,
  now = currentUnixTime,
  isClosed,
  isNonDurableEvent,
  isStoredRecordLive,
  matchStored,
  emitStored,
  logError = () => {}
}) {
  const deliveredScheduledIdKeys = new Set()
  let timer = null
  let timerCreatedAt = Infinity
  let lowerCreatedAt = scheduledCutoff(now())
  let scanRunning = false
  let scanQueued = false

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
    timerCreatedAt = Infinity
  }

  const arm = createdAt => {
    if (isClosed() || !Number.isInteger(createdAt) || createdAt <= scheduledCutoff(now())) return
    if (timer && timerCreatedAt <= createdAt) return

    clearTimer()
    timerCreatedAt = createdAt
    timer = setTimeout(runScanAndLog, scheduledDelayMs(createdAt))
    timer.unref?.()
  }

  const start = () => {
    if (isClosed()) return
    scheduleNextFuture().catch(error => logError('Scheduled catch-up failed.', error))
  }

  const close = () => {
    clearTimer()
  }

  const shouldDelay = event => isScheduledDurableFuture(event, {
    now: now(),
    isNonDurableEvent
  })

  const runScan = async () => {
    if (isClosed()) return
    clearTimer()

    if (scanRunning) {
      scanQueued = true
      return
    }

    scanRunning = true
    try {
      const needsMore = await deliverDue()
      if (!isClosed() && needsMore) {
        timer = setTimeout(runScanAndLog, 0)
        timerCreatedAt = lowerCreatedAt + 1
        timer.unref?.()
        return
      }
    } finally {
      scanRunning = false
    }

    if (isClosed()) return
    if (scanQueued) {
      scanQueued = false
      runScanAndLog()
      return
    }

    await scheduleNextFuture()
  }

  const runScanAndLog = () => {
    runScan().catch(error => logError('Scheduled scan failed.', error))
  }

  const deliverDue = async () => {
    const current = now()
    const cutoff = scheduledCutoff(current)
    if (cutoff <= lowerCreatedAt) return false

    const db = await openDb()
    if (!db || isClosed()) return false

    let delivered = 0
    let hitBatchLimit = false
    const range = IDBKeyRange.bound(lowerCreatedAt, cutoff, true, false)

    await scanCreatedAt(db, range, {
      direction: 'next',
      onItem: stored => {
        if (isClosed()) return false
        if (!stored || deliveredScheduledIdKeys.has(stored.i) || !isStoredRecordLive(stored, current)) return true

        const filter = matchStored(stored)
        if (!filter) return true

        deliveredScheduledIdKeys.add(stored.i)
        emitStored(filter, stored)
        delivered++

        if (isClosed()) return false
        if (delivered >= SCHEDULED_DELIVERY_BATCH_SIZE) {
          hitBatchLimit = true
          return false
        }
        return true
      }
    })

    if (!hitBatchLimit) lowerCreatedAt = cutoff
    return hitBatchLimit
  }

  const scheduleNextFuture = async () => {
    if (isClosed()) return

    const db = await openDb()
    if (!db || isClosed()) return

    const current = now()
    const cutoff = scheduledCutoff(current)
    const range = IDBKeyRange.lowerBound(cutoff, true)
    let nextCreatedAt = null

    await scanCreatedAt(db, range, {
      direction: 'next',
      onItem: stored => {
        if (isClosed()) return false
        if (!stored || !isStoredRecordLive(stored, current)) return true
        if (!matchStored(stored)) return true

        nextCreatedAt = stored.event.created_at
        return false
      }
    })

    if (nextCreatedAt !== null) arm(nextCreatedAt)
  }

  return {
    start,
    close,
    shouldDelay,
    arm
  }
}

export function isScheduledDurableFuture (event, {
  now = currentUnixTime(),
  isNonDurableEvent = () => false
} = {}) {
  return !!event &&
    Number.isInteger(event.created_at) &&
    !isNonDurableEvent(event) &&
    event.created_at > scheduledCutoff(now)
}

function scheduledCutoff (now) {
  return now + SCHEDULED_EVENT_SKEW
}

function scheduledDelayMs (createdAt) {
  const dueAt = (createdAt - SCHEDULED_EVENT_SKEW) * 1000
  return Math.min(MAX_SCHEDULED_TIMEOUT_MS, Math.max(0, dueAt - Date.now()))
}

function currentUnixTime () {
  return Math.floor(Date.now() / 1000)
}
