export const MIB = 1024 * 1024
export const quotaFields = ['publicBytes', 'cacheBytes', 'privateBytes']

export function parseQuotaMiB (text) {
  if (typeof text !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text.trim())) return null
  const bytes = Math.round(Number(text) * MIB)
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null
}

export function quotaDraft (limits) {
  return Object.fromEntries(quotaFields.map(key => [key, String(limits[key] / MIB)]))
}

export function draftOverrides (draft, dirty) {
  return Object.fromEntries(quotaFields.filter(key => dirty[key]).map(key => [key, parseQuotaMiB(draft[key])]))
}

export function usageSegments (usage) {
  return [Math.max(0, usage.publicBytes - usage.cacheBytes), usage.cacheBytes, usage.privateBytes]
}

export function occupancy (used, limit) {
  return limit === 0 ? (used > 0 ? 100 : 0) : Math.min(100, used / limit * 100)
}
