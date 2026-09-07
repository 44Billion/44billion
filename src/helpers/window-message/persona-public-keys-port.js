import { tell } from './index.js'

export function connectPersonaPublicKeysPort (service, { record, port, signal, send = tell, onChange }) {
  const connection = service.connect(record, keys => {
    onChange?.(keys)
    send(port, { code: 'PERSONA_PUBLIC_KEYS_CHANGED', payload: keys })
  })
  port.addEventListener('message', event => {
    if (event.data.code === 'INSTANCE_DOCUMENT_UNLOADED') connection.disconnect()
  }, { signal })
  if (signal.aborted) connection.disconnect()
  else signal.addEventListener('abort', connection.disconnect, { once: true })
  return connection.initialPublicKeys
}
