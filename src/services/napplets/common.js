import { bech32 } from '@scure/base'
import { createCommonService } from '@kehto/services'

// The installed shared handler's nrelay fallback skips checksum validation.
// Validate all public identifiers before delegating its result formatting.
export function createNappletCommonService (social) {
  const service = createCommonService(social)
  const handle = service.handleMessage.bind(service)
  service.handleMessage = (windowId, message, send) => {
    if (message.type === 'common.decodeNip19') {
      try {
        const decoded = bech32.decode(message.value, 5000)
        if (!['npub', 'note', 'nprofile', 'nevent', 'naddr', 'nrelay'].includes(decoded.prefix)) throw new Error('unsupported-nip19-type')
        bech32.fromWords(decoded.words)
      } catch (error) {
        send({ type: 'common.decodeNip19.result', id: message.id ?? '', ok: false, error: error.message === 'unsupported-nip19-type' ? error.message : 'invalid-nip19' })
        return
      }
    }
    handle(windowId, message, send)
  }
  return service
}
