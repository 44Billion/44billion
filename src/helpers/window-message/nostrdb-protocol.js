export const NOSTRDB_PUBLIC_METHODS = ['add', 'addPersonalCopy', 'remove', 'query', 'count', 'subscribe', 'supports']
export const NOSTRDB_ONE_SHOT_METHODS = NOSTRDB_PUBLIC_METHODS.filter(method => method !== 'subscribe')
export const NOSTRDB_STREAM_DONE = 'nostrdb:done'
export const NOSTRDB_RECOVERY_READ = Symbol('nostrdb.recoveryRead')
// Symbols cannot cross the structured-clone boundary. The trusted vault path
// injects this cap locally when it needs more than the public 200-row limit.
export const NOSTRDB_TRUSTED_QUERY_LIMIT = Symbol('nostrdb.trustedQueryLimit')
export const NOSTRDB_TRUSTED_QUERY_MAX_RESULTS = 1025
export const NOSTRDB_SUPPORTS_TIMEOUT_MS = 5_000
export const NOSTRDB_ONESHOT_TIMEOUT_MS = 5 * 60 * 1000
export const NOSTRDB_SNAPSHOT_FIRST_TIMEOUT_MS = 7 * 60 * 1000
export const NOSTRDB_SNAPSHOT_IDLE_TIMEOUT_MS = 60 * 1000
export const NOSTRDB_REQUEST_TIMEOUT = 'NOSTRDB_REQUEST_TIMEOUT'
export const NOSTRDB_SNAPSHOT_TIMEOUT = 'NOSTRDB_SNAPSHOT_TIMEOUT'
export const NOSTRDB_REQUEST_CANCELLED = 'NOSTRDB_REQUEST_CANCELLED'

export function nostrDbStreamDonePayload (subscriptionId) {
  return { type: NOSTRDB_STREAM_DONE, subscriptionId }
}

export function isNostrDbStreamDonePayload (payload, subscriptionId) {
  return payload?.type === NOSTRDB_STREAM_DONE && payload.subscriptionId === subscriptionId
}
