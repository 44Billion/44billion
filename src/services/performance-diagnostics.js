const enabled = typeof IS_DEVELOPMENT !== 'undefined' && IS_DEVELOPMENT
const recent = []
const schedulerStages = new Set([
  'scheduler-wait',
  'nostrdb-scheduler-start',
  'nostrdb-scheduler-complete'
])
const fields = ['stage', 'requestId', 'parentId', 'eventId', 'seedRecordId', 'publicationId', 'priority', 'chunk', 'archive', 'elapsedMs', 'waiting', 'running', 'kind', 'durationMs', 'category', 'count', 'examined', 'probes', 'keysExamined', 'earlyDecision', 'budgetExhausted', 'deleted', 'exhausted', 'excess', 'cacheHit', 'cacheHits', 'operations', 'operationCount', 'rowCount', 'uniqueCount', 'existingCount', 'insertedCount', 'blockedCount', 'expiredCount', 'storedCount', 'skippedCount', 'foregroundIdle', 'schedulerClass', 'schedulerMode', 'schedulerWaitMs', 'schedulerActive', 'schedulerWaiting', 'storeCount', 'schedulerConflict', 'bufferedAmount', 'queuedFrames', 'queuedBytes', 'pendingFrames', 'pendingBytes', 'at']

export function recordPerformance (entry) {
  if (!enabled) return
  const value = Object.fromEntries(fields.filter(key => {
    const value = entry[key]
    if (['stage', 'requestId', 'parentId', 'eventId', 'seedRecordId', 'publicationId', 'category', 'schedulerClass', 'schedulerMode'].includes(key)) return typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value)
    return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
  }).map(key => [key, entry[key]]))
  recent.push(value)
  if (recent.length > 128) recent.shift()
  if (!schedulerStages.has(value.stage) || globalThis.__44BILLION_SCHEDULER_TRACE__ === true) {
    console.debug(`[messaging-performance] ${JSON.stringify(value)}`)
  }
}

export function withRequestDiagnostics (message, parent) {
  if (!enabled) return message
  return { ...message, diagnostics: { requestId: crypto.randomUUID(), ...(parent ? { parentId: parent.reqId, ...(parent.eventId ? { eventId: parent.eventId } : {}), ...(parent.seedRecordId ? { seedRecordId: parent.seedRecordId } : {}) } : {}) } }
}

export function performanceSnapshot () { return recent.map(entry => ({ ...entry })) }
