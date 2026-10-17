import { signerStates } from '#services/signer-state.js'
import { tell, reply } from './index.js'
import { serializeError } from '#helpers/error.js'

export function connectSignerCapabilitiesPort ({ port, signal, ownerPubkey, readKeys }) {
  let initial
  const stop = signerStates.subscribeContentKeyCapabilities({ ownerPubkey, readKeys }, capabilities => {
    if (!initial) initial = capabilities
    else tell(port, { code: 'NIP07_CAPABILITIES_CHANGED', payload: capabilities })
  })
  if (signal.aborted) stop()
  else {
    signal.addEventListener('abort', stop, { once: true })
    port.addEventListener('message', event => {
      if (event.data.code === 'INSTANCE_DOCUMENT_UNLOADED') stop()
    }, { signal })
    globalThis.window?.addEventListener('storage', event => {
      if (event.key === null || event.key.endsWith('_supportsContentKeyMethods')) signerStates.invalidate()
    }, { signal })
  }
  return initial
}

export function connectSignerStatePort ({ port, signal, ownerPubkey, readKeys, readFlags }) {
  const subscriptions = new Map()
  let closed = false
  const dispose = () => {
    closed = true
    for (const stop of subscriptions.values()) stop()
    subscriptions.clear()
  }
  port.addEventListener('message', event => {
    const { code, payload = {} } = event.data
    if (code === 'INSTANCE_DOCUMENT_UNLOADED') { dispose(); return }
    if (closed) return
    if (code === 'SIGNER_STATE_UNSUBSCRIBE') {
      subscriptions.get(payload.id)?.(); subscriptions.delete(payload.id)
      return
    }
    if (!['SIGNER_STATE_GET', 'SIGNER_STATE_SUBSCRIBE', 'CONTENT_KEYS_SUBSCRIBE'].includes(code)) return
    try {
      const scope = { pubkey: payload.pubkey, ownerPubkey, readKeys, readFlags }
      if (code === 'SIGNER_STATE_GET') {
        reply(event, { payload: signerStates.read(scope) }, { to: port })
      } else {
        if (typeof payload.id !== 'string' || subscriptions.has(payload.id)) throw new Error('INVALID_SUBSCRIPTION_ID')
        const contentKeys = code === 'CONTENT_KEYS_SUBSCRIBE'
        const subscribe = contentKeys ? signerStates.subscribeContentKeys : signerStates.subscribe
        const stop = subscribe(scope, (state, revoked = false) => {
          tell(port, { code: 'SIGNER_STATE_CHANGED', payload: { id: payload.id, state, ...(revoked ? { revoked: true } : {}) } })
          if (revoked || state.access === 'revoked') subscriptions.delete(payload.id)
        })
        subscriptions.set(payload.id, stop)
        reply(event, { payload: true }, { to: port })
      }
    } catch (error) { reply(event, { error: serializeError(error, { code: error.code }) }, { to: port }) }
  }, { signal })
  if (signal.aborted) dispose()
  else signal.addEventListener('abort', dispose, { once: true })
  return dispose
}
