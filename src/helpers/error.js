// use this if you need to send Error objects
// with extra context info via postMessage
const diagnosticFields = ['code', 'category', 'stage', 'channelPubkey', 'eventId', 'eventKind', 'senderPubkey', 'receiverPubkey', 'ownContentPubkey', 'peerContentPubkey', 'hasOwnContentKey']

export function serializeError (err, context = {}, depth = 0) {
  const diagnostics = Object.fromEntries(diagnosticFields
    .filter(key => ['string', 'number', 'boolean'].includes(typeof (err[key] ?? err.context?.[key])))
    .map(key => [key, err[key] ?? err.context?.[key]]))
  return {
    type: 'error',
    name: err.name,
    message: err.message,
    stack: err.stack,
    context: { ...diagnostics, ...context },
    ...(depth < 4 && err.cause && typeof err.cause === 'object' ? { cause: serializeError(err.cause, {}, depth + 1) } : {})
  }
}
export function reviveError (err, depth = 0) {
  if (err instanceof Error) return err

  const error = new Error(err.message)
  error.name = err.name || 'Error'
  error.stack = err.stack
  Object.assign(error, err.context || {})
  if (depth < 4 && err.cause) error.cause = reviveError(err.cause, depth + 1)
  return error
}
