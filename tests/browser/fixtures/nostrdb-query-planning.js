import { copy, db } from './nostrdb-contention.js'
import { createAccountEventCoverage } from '#services/account-event-coverage.js'
import { finalizeEvent } from 'libp2r2p/event'
import { getPublicKey } from 'libp2r2p/key'
import { NOSTRDB_RECOVERY_READ } from '#helpers/window-message/nostrdb-protocol.js'

const secret = new Uint8Array(32).fill(21)
const { fixture } = globalThis
let serial = 0
let countCalls = 0
const probes = []
const originalCount = IDBIndex.prototype.count
IDBIndex.prototype.count = function (...args) { countCalls++; return originalCount.apply(this, args) }
const originalKeys = IDBIndex.prototype.getAllKeys
IDBIndex.prototype.getAllKeys = function (...args) {
  const request = originalKeys.apply(this, args)
  request.addEventListener('success', () => probes.push({ limit: args[1], keys: request.result.length }))
  return request
}
const coverage = []
globalThis.plannerFixture = {
  async seed () {
    await fixture.seed()
    for (const value of [21, 23, 24]) {
      const coordinator = createAccountEventCoverage(getPublicKey(new Uint8Array(32).fill(value)))
      const kinds = [0, 3, 9, 1063, 10002]
      await coordinator.reconcile(kinds)
      const records = await coordinator.read('wss://fixture.invalid', kinds)
      coverage.push({ coordinator, records })
    }
  },
  async seedHistory () {
    for (let i = 0; i < 50; i++) {
      const result = await db.add(await copy({ kind: 9, created_at: 1000 + i, tags: [], content: `history-${i}` }, 'history'))
      if (!result.ok) throw new Error('history fixture admission failed')
    }
  },
  async recoveryPage () {
    probes.length = 0
    const measures = []
    const filter = {
      kinds: [1006],
      authors: [fixture.owner],
      '#k': ['30078'],
      '#c': ['1006::'],
      '#v': ['0', '1'],
      '&o': ['1006:#t:seed'],
      limit: 128,
      search: 'sort:desc'
    }
    const { results } = await db.query(filter, {
      schedulerClass: 'background',
      [NOSTRDB_RECOVERY_READ]: true,
      onTiming: row => measures.push(row)
    })
    return {
      resultCount: results.length,
      probes: probes.length,
      plan: measures.find(row => row.stage === 'query-planning')
    }
  },
  async burst (n, history = false) {
    countCalls = 0; probes.length = 0
    const measures = []
    const readsMs = []
    const at = performance.now()
    const observe = flow => row => measures.push({ ...row, flow })
    const reads = Array.from({ length: n }, (_, i) => {
      const until = 1049 - (i % 5) * 10
      const filter = {
        kinds: [1006], authors: [fixture.owner], '#k': ['9'], '#c': [history ? '1006::history' : `missing-${i}`], '#v': ['0', '1'],
        ...(history ? { until, limit: 10 } : { limit: 50 })
      }
      return db.query(filter, { onTiming: observe('read') }).then(({ results }) => {
        if (history) {
          const expected = Array.from({ length: 10 }, (_, offset) => until - offset)
          if (JSON.stringify(results.map(event => event.created_at)) !== JSON.stringify(expected)) throw new Error('history page changed')
        } else if (results.length) throw new Error('unexpected conversation result')
        readsMs.push(performance.now() - at)
      })
    })
    const maintenance = Promise.all(coverage.map(async ({ coordinator, records }) => {
      await coordinator.mark(records, 0, 100 + serial)
      await coordinator.read('wss://fixture.invalid', [0, 3, 9, 1063, 10002])
    }))
    const event = history
      ? await copy({ kind: 9, created_at: 2000 + ++serial, tags: [], content: `send-${serial}` }, `dm:${fixture.owner}`)
      : finalizeEvent({ kind: 0, created_at: 2000 + ++serial, tags: [], content: '{}' }, secret)
    const start = performance.now()
    const result = await db.add(event, { onTiming: observe('write') })
    if (!result.ok) throw new Error('foreground write failed')
    const writeMs = performance.now() - start
    await Promise.all([...reads, maintenance])
    readsMs.sort((a, b) => a - b)
    const plans = measures.filter(row => row.stage === 'query-planning')
    return {
      n, history, totalMs: performance.now() - at, writeMs,
      readMedianMs: readsMs[Math.floor(readsMs.length / 2)], readP95Ms: readsMs[Math.ceil(readsMs.length * 0.95) - 1],
      quotaWaitMs: measures.filter(row => row.flow === 'write' && row.stage === 'quota-lock-wait').reduce((sum, row) => sum + row.elapsedMs, 0),
      quotaHeldMs: measures.filter(row => row.flow === 'write' && row.stage === 'quota-lock-execution').reduce((sum, row) => sum + row.elapsedMs, 0),
      planningMs: plans.reduce((sum, row) => sum + row.elapsedMs, 0),
      countCalls, probes: probes.length, keysExamined: probes.reduce((sum, probe) => sum + probe.keys, 0),
      maxProbeLimit: Math.max(0, ...probes.map(probe => probe.limit)),
      maxPlanningKeys: Math.max(0, ...plans.map(row => row.keysExamined ?? 0)),
      readPlans: plans.filter(row => row.flow === 'read').length,
      earlyReadPlans: plans.filter(row => row.flow === 'read' && row.earlyDecision).length
    }
  }
}
