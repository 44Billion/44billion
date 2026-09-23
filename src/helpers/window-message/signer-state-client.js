export function createSignerStateClient ({ handshake, ask, tell, reportError = console.error }) {
  const subscriptions = new Map()
  let closed = false
  const scope = options => options?.pubkey === undefined ? {} : { pubkey: options.pubkey }
  async function request (code, payload) {
    const port = await handshake
    if (closed) throw new Error('APP_DOCUMENT_UNLOADED')
    const result = await ask(port, { code, payload })
    if (closed) throw new Error('APP_DOCUMENT_UNLOADED')
    if (result.error) throw result.error
    return result.payload
  }
  return {
    getSignerState: options => request('SIGNER_STATE_GET', scope(options)),
    onSignerStateChanged (listener, options) {
      if (typeof listener !== 'function') throw new TypeError('listener should be a function')
      const id = crypto.randomUUID()
      const entry = { listener }
      subscriptions.set(id, entry)
      const unsubscribe = () => {
        subscriptions.delete(id)
        handshake.then(port => {
          if (!closed) tell(port, { code: 'SIGNER_STATE_UNSUBSCRIBE', payload: { id } })
        }).catch(reportError)
      }
      unsubscribe.ready = request('SIGNER_STATE_SUBSCRIBE', { ...scope(options), id }).catch(error => {
        subscriptions.delete(id)
        throw error
      })
      unsubscribe.ready.catch(reportError)
      return unsubscribe
    },
    receive ({ id, state }) {
      const entry = subscriptions.get(id)
      if (!entry || closed) return
      queueMicrotask(() => {
        if (closed || subscriptions.get(id) !== entry) return
        try { Promise.resolve(entry.listener({ ...state })).catch(reportError) } catch (error) { reportError(error) }
        if (state.access === 'revoked') subscriptions.delete(id)
      })
    },
    close () { closed = true; subscriptions.clear() }
  }
}
