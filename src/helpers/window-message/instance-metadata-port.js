import { tell } from './index.js'

export function connectInstanceMetadataPort (service, { record, port, signal, send = tell }) {
  const connection = service.connect(record, metadata => {
    send(port, { code: 'INSTANCE_METADATA_CHANGED', payload: metadata })
  })
  // A real navigation may unload the document before its successor handshakes.
  port.addEventListener('message', event => {
    if (event.data.code === 'INSTANCE_DOCUMENT_UNLOADED') connection.disconnect()
  }, { signal })
  if (signal.aborted) connection.disconnect()
  else signal.addEventListener('abort', connection.disconnect, { once: true })
  return connection.initialMetadata
}
