import assert from 'node:assert/strict'
import { test } from 'node:test'

test('development diagnostics bound history and retain only identifiers and numeric measurements', async () => {
  const previous = globalThis.IS_DEVELOPMENT
  globalThis.IS_DEVELOPMENT = true
  const previousDebug = console.debug
  console.debug = () => {}
  try {
    const { recordPerformance, performanceSnapshot } = await import('../../src/services/performance-diagnostics.js?development-test')
    for (let index = 0; index < 140; index++) recordPerformance({ stage: 'vault-dispatch', elapsedMs: index, requestId: `request-${index}`, parentId: { secret: true }, eventId: 'unsafe string with spaces', params: ['private'], ciphertext: 'secret', running: Infinity })
    const snapshot = performanceSnapshot()
    assert.equal(snapshot.length, 128)
    assert.deepEqual(snapshot[0], { stage: 'vault-dispatch', requestId: 'request-12', elapsedMs: 12 })
    const { withRequestDiagnostics } = await import('../../src/services/performance-diagnostics.js?development-test')
    const seedRecordId = `libp2r2p:recovery:seed:${'a'.repeat(64)}`
    const message = withRequestDiagnostics({ code: 'NIP07' }, { reqId: 'origin', eventId: 'event', seedRecordId })
    assert.equal(message.diagnostics.parentId, 'origin')
    assert.equal(message.diagnostics.seedRecordId, seedRecordId)
    recordPerformance({ stage: 'vault-dispatch', seedRecordId, publicationId: 'envelope', content: 'private' })
    assert.deepEqual(performanceSnapshot().at(-1), { stage: 'vault-dispatch', seedRecordId, publicationId: 'envelope' })
    snapshot[0].stage = 'changed'
    assert.equal(performanceSnapshot()[0].stage, 'vault-dispatch')
    recordPerformance({ stage: 'query-planning', probes: 2, keysExamined: 66, earlyDecision: true, budgetExhausted: false, keys: ['private'], ranges: ['private'] })
    assert.deepEqual(performanceSnapshot().at(-1), { stage: 'query-planning', probes: 2, keysExamined: 66, earlyDecision: true, budgetExhausted: false })
    recordPerformance({
      stage: 'query-planning',
      probes: 2,
      keysExamined: 130,
      examined: 2,
      recoveryPlan: true,
      recoveryPath: 'o',
      recoveryBaselineKeys: 65,
      recoveryPreferredKeys: 65,
      recoveryBaselineComplete: false,
      recoveryPreferredComplete: false,
      tagValues: ['private']
    })
    assert.deepEqual(performanceSnapshot().at(-1), {
      stage: 'query-planning',
      probes: 2,
      keysExamined: 130,
      examined: 2,
      recoveryPlan: true,
      recoveryPath: 'o',
      recoveryBaselineKeys: 65,
      recoveryPreferredKeys: 65,
      recoveryBaselineComplete: false,
      recoveryPreferredComplete: false
    })
    recordPerformance({
      stage: 'recovery-cursor-chunk',
      cursorIndex: 1,
      chunkIndex: 2,
      examined: 64,
      matched: 21,
      resumed: true,
      chunkDone: false,
      elapsedMs: 9,
      indexKey: ['private'],
      primaryKey: 'private'
    })
    assert.deepEqual(performanceSnapshot().at(-1), {
      stage: 'recovery-cursor-chunk',
      cursorIndex: 1,
      chunkIndex: 2,
      examined: 64,
      matched: 21,
      resumed: true,
      chunkDone: false,
      elapsedMs: 9
    })
    recordPerformance({ stage: 'recovery-archive-result', rowCount: 3, uniqueCount: 2, existingCount: 1, insertedCount: 1, blockedCount: 0, expiredCount: 1, storedCount: 2, skippedCount: 2, schedulerMode: 'readonly' })
    assert.deepEqual(performanceSnapshot().at(-1), {
      stage: 'recovery-archive-result',
      rowCount: 3,
      uniqueCount: 2,
      existingCount: 1,
      insertedCount: 1,
      blockedCount: 0,
      expiredCount: 1,
      storedCount: 2,
      skippedCount: 2,
      schedulerMode: 'readonly'
    })
  } finally {
    console.debug = previousDebug
    if (previous === undefined) delete globalThis.IS_DEVELOPMENT
    else globalThis.IS_DEVELOPMENT = previous
  }
})

test('production diagnostics stay disabled and do not extend request envelopes', async () => {
  const previous = globalThis.IS_DEVELOPMENT
  globalThis.IS_DEVELOPMENT = false
  try {
    const { recordPerformance, performanceSnapshot, withRequestDiagnostics } = await import('../../src/services/performance-diagnostics.js?production-test')
    const message = { code: 'NIP07', payload: { method: 'obfuscate' } }
    assert.equal(withRequestDiagnostics(message, { reqId: 'request' }), message)
    recordPerformance({ stage: 'vault-dispatch', elapsedMs: 1 })
    assert.deepEqual(performanceSnapshot(), [])
  } finally {
    if (previous === undefined) delete globalThis.IS_DEVELOPMENT
    else globalThis.IS_DEVELOPMENT = previous
  }
})

test('scheduler console traces are opt-in while diagnostics remain in the bounded snapshot', async () => {
  const previousDevelopment = globalThis.IS_DEVELOPMENT
  const previousSchedulerTrace = globalThis.__44BILLION_SCHEDULER_TRACE__
  const previousDebug = console.debug
  const records = []
  globalThis.IS_DEVELOPMENT = true
  delete globalThis.__44BILLION_SCHEDULER_TRACE__
  console.debug = value => records.push(JSON.parse(value.slice('[messaging-performance] '.length)))
  try {
    const { recordPerformance, performanceSnapshot } = await import('../../src/services/performance-diagnostics.js?scheduler-quiet-test')
    recordPerformance({ stage: 'scheduler-wait', schedulerClass: 'foreground', schedulerWaitMs: 2 })
    recordPerformance({ stage: 'nostrdb-scheduler-start', schedulerMode: 'readwrite', schedulerActive: 1 })
    recordPerformance({ stage: 'nostrdb-scheduler-complete', schedulerActive: 0 })
    recordPerformance({ stage: 'nostrdb-scheduler-preempt', schedulerClass: 'background' })
    recordPerformance({ stage: 'nostrdb-scheduler-retry', schedulerClass: 'background' })
    recordPerformance({ stage: 'quota-mutation', elapsedMs: 3 })

    assert.deepEqual(records, [{ stage: 'quota-mutation', elapsedMs: 3 }])
    assert.deepEqual(performanceSnapshot().slice(-6), [
      { stage: 'scheduler-wait', schedulerClass: 'foreground', schedulerWaitMs: 2 },
      { stage: 'nostrdb-scheduler-start', schedulerMode: 'readwrite', schedulerActive: 1 },
      { stage: 'nostrdb-scheduler-complete', schedulerActive: 0 },
      { stage: 'nostrdb-scheduler-preempt', schedulerClass: 'background' },
      { stage: 'nostrdb-scheduler-retry', schedulerClass: 'background' },
      { stage: 'quota-mutation', elapsedMs: 3 }
    ])

    globalThis.__44BILLION_SCHEDULER_TRACE__ = true
    recordPerformance({ stage: 'scheduler-wait', schedulerClass: 'background', schedulerWaiting: 2 })
    assert.deepEqual(records.at(-1), {
      stage: 'scheduler-wait',
      schedulerClass: 'background',
      schedulerWaiting: 2
    })
  } finally {
    console.debug = previousDebug
    if (previousDevelopment === undefined) delete globalThis.IS_DEVELOPMENT
    else globalThis.IS_DEVELOPMENT = previousDevelopment
    if (previousSchedulerTrace === undefined) delete globalThis.__44BILLION_SCHEDULER_TRACE__
    else globalThis.__44BILLION_SCHEDULER_TRACE__ = previousSchedulerTrace
  }
})
