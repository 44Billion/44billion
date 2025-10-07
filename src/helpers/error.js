// use this if you need to send Error objects
// with extra context info via postMessage
export function serializeError (err, context = {}) {
  return {
    type: 'error',
    name: err.name,
    message: err.message,
    stack: err.stack,
    context
  }
}
export function reviveError (err) {
  if (err instanceof Error) return err

  const error = new Error(err.message)
  error.name = err.name || 'Error'
  error.stack = err.stack
  Object.assign(error, err.context || {})
  return error
}
