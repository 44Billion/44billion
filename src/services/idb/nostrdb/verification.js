import { isValidEvent } from 'libp2r2p/event'

export function verifyEventSignature (event) {
  try { return isValidEvent(event) } catch { return false }
}
