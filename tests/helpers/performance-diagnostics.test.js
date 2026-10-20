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
