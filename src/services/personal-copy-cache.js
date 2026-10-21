import { recordPerformance } from './performance-diagnostics.js'
// Only stable internal personal-copy mirrors are retained, never IDs or callbacks.
const values = new Map()
let generation = 0
export function clearPersonalCopyCache () { generation++; values.clear() }

const cacheable = scope => scope === '' || scope === '.pubkey'
const keyFor = (account, generation, value, kind, scope) => JSON.stringify([account, generation, kind, scope, value])

function pruneValues (now) {
  for (const [key, record] of values) if (now - record.usedAt >= 60000) values.delete(key)
}

function remember (key, account, result, now) {
  values.set(key, { account, result, usedAt: now })
  const own = [...values].filter(([, record]) => record.account === account)
  while (own.length > 64) values.delete(own.shift()[0])
  while (values.size > 256) values.delete(values.keys().next().value)
}

export async function cachedPersonalCopyObfuscations (account, operations, batchOperation, diagnostics) {
  const epoch = generation
  const now = performance.now()
  pruneValues(now)
  const results = new Array(operations.length)
  const misses = new Map()
  let cacheHits = 0
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]
    if (!cacheable(operation.scope)) {
      const key = keyFor(account, epoch, operation.value, operation.kind, operation.scope)
      if (!misses.has(key)) misses.set(key, operation)
      continue
    }
    const key = keyFor(account, epoch, operation.value, operation.kind, operation.scope)
    const hit = values.get(key)
    if (hit) {
      cacheHits++
      values.delete(key); hit.usedAt = now; values.set(key, hit)
      results[index] = { key, result: hit.result }
      continue
    }
    if (!misses.has(key)) misses.set(key, operation)
  }
  recordPerformance({ ...diagnostics, stage: 'personal-copy-cache', cacheHit: cacheHits > 0, cacheHits, count: values.size, operations: operations.length })
  const pending = [...misses]
  const pendingResults = new Map()
  if (pending.length) {
    const output = await batchOperation(pending.map(([, operation]) => operation))
    if (!Array.isArray(output) || output.length !== pending.length) throw new Error('PERSONAL_COPY_OBFUSCATE_BATCH_INVALID_RESULT')
    for (let index = 0; index < pending.length; index++) {
      const [key, operation] = pending[index]
      if (typeof output[index] !== 'string') throw new Error('PERSONAL_COPY_OBFUSCATE_BATCH_INVALID_RESULT')
      if (cacheable(operation.scope) && epoch === generation) remember(key, account, output[index], performance.now())
      pendingResults.set(key, output[index])
    }
  }
  for (let index = 0; index < operations.length; index++) {
    if (results[index] !== undefined) {
      if (results[index]?.key) results[index] = results[index].result
      continue
    }
    const operation = operations[index]
    const key = keyFor(account, epoch, operation.value, operation.kind, operation.scope)
    results[index] = pendingResults.get(key)
  }
  return results
}

export async function cachedPersonalCopyObfuscation (account, value, kind, scope, operation, diagnostics) {
  if (!cacheable(scope)) return operation()
  const epoch = generation
  const key = JSON.stringify([account, epoch, kind, scope, value])
  const now = performance.now()
  pruneValues(now)
  const hit = values.get(key)
  recordPerformance({ ...diagnostics, stage: 'personal-copy-cache', cacheHit: Boolean(hit), count: values.size })
  if (hit) { values.delete(key); hit.usedAt = now; values.set(key, hit); return hit.result }
  const result = await operation()
  if (epoch !== generation) return result
  remember(key, account, result, performance.now())
  return result
}
