import { parsePriorityFrame } from './priority.js'

export const MAX_RELAY_RETRY_AFTER_MS = 5 * 60 * 1000

function retryAfterValue (retryAt, now) {
  return String(Math.min(MAX_RELAY_RETRY_AFTER_MS, Math.max(1, Math.ceil(retryAt - now))))
}

export function rewriteRetryFrame (data, retry = null, now = Date.now()) {
  if (!retry || typeof data !== 'string') return data
  const frame = parsePriorityFrame(data)
  if (!Array.isArray(frame)) return data
  const forwarded = [...frame]
  forwarded[retry.paramsIndex] = retryAfterValue(retry.retryAt, now)
  return JSON.stringify(forwarded)
}

export function maxRetryFrame (data, retry = null) {
  if (!retry || typeof data !== 'string') return data
  const frame = parsePriorityFrame(data)
  if (!Array.isArray(frame)) return data
  const forwarded = [...frame]
  forwarded[retry.paramsIndex] = String(MAX_RELAY_RETRY_AFTER_MS)
  return JSON.stringify(forwarded)
}
