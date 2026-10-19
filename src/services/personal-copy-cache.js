import { recordPerformance } from './performance-diagnostics.js'
// Only stable internal personal-copy mirrors are retained, never IDs or callbacks.
const values = new Map()
let generation = 0
export function clearPersonalCopyCache () { generation++; values.clear() }
export async function cachedPersonalCopyObfuscation (account, value, kind, scope, operation, diagnostics) {
  if (scope !== '' && scope !== '.pubkey') return operation()
  const epoch = generation
  const key = JSON.stringify([account, epoch, kind, scope, value])
  const now = performance.now()
  for (const [key, record] of values) if (now - record.usedAt >= 60000) values.delete(key)
  const hit = values.get(key)
  recordPerformance({ ...diagnostics, stage: 'personal-copy-cache', cacheHit: Boolean(hit), count: values.size })
  if (hit) { values.delete(key); hit.usedAt = now; values.set(key, hit); return hit.result }
  const result = await operation()
  if (epoch !== generation) return result
  values.set(key, { account, result, usedAt: performance.now() })
  const own = [...values].filter(([, record]) => record.account === account)
  while (own.length > 64) values.delete(own.shift()[0])
  while (values.size > 256) values.delete(values.keys().next().value)
  return result
}
