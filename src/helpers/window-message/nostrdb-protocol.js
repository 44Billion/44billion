export const NOSTRDB_PUBLIC_METHODS = ['add', 'addPersonalCopy', 'query', 'count', 'subscribe', 'supports']
export const NOSTRDB_ONE_SHOT_METHODS = NOSTRDB_PUBLIC_METHODS.filter(method => method !== 'subscribe')
export const NOSTRDB_STREAM_DONE = 'nostrdb:done'

export function nostrDbStreamDonePayload (subscriptionId) {
  return { type: NOSTRDB_STREAM_DONE, subscriptionId }
}

export function isNostrDbStreamDonePayload (payload, subscriptionId) {
  return payload?.type === NOSTRDB_STREAM_DONE && payload.subscriptionId === subscriptionId
}
