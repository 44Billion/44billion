// Strict NIP-01/42/45/77 shape checks. Only an exact match is treated as a
// Nostr relay; anything else (binary frames, other JSON protocols, malformed
// or unknown ops) must stay a plain 1:1 WebSocket.
const CLIENT_OPS = new Set(['REQ', 'CLOSE', 'EVENT', 'COUNT', 'AUTH', 'NEG-OPEN', 'NEG-MSG', 'NEG-CLOSE'])
const SERVER_OPS = new Set(['EVENT', 'EOSE', 'CLOSED', 'OK', 'NOTICE', 'AUTH', 'COUNT', 'NEG-MSG', 'NEG-ERR'])

function isPlainObject (value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isEvent (value) {
  return isPlainObject(value) &&
    typeof value.id === 'string' &&
    typeof value.pubkey === 'string' &&
    typeof value.sig === 'string' &&
    typeof value.content === 'string' &&
    Number.isSafeInteger(value.kind) &&
    Number.isSafeInteger(value.created_at) &&
    Array.isArray(value.tags)
}

function isFilters (values) {
  return values.length > 0 && values.every(isPlainObject)
}

function matchesClientShape (message) {
  const op = message[0]
  if (op === 'CLOSE' || op === 'NEG-CLOSE') return message.length === 2 && typeof message[1] === 'string'
  if (op === 'REQ' || op === 'COUNT') return message.length >= 3 && typeof message[1] === 'string' && isFilters(message.slice(2))
  if (op === 'EVENT') return message.length === 2 && isEvent(message[1])
  if (op === 'AUTH') return message.length === 2 && isEvent(message[1]) && message[1].kind === 22242
  if (op === 'NEG-OPEN') return message.length === 4 && typeof message[1] === 'string' && isPlainObject(message[2]) && typeof message[3] === 'string'
  if (op === 'NEG-MSG') return message.length === 3 && typeof message[1] === 'string' && typeof message[2] === 'string'
  return false
}

function matchesServerShape (message) {
  const op = message[0]
  if (op === 'EOSE') return message.length === 2 && typeof message[1] === 'string'
  if (op === 'EVENT') return message.length === 3 && typeof message[1] === 'string' && isEvent(message[2])
  if (op === 'CLOSED') return message.length === 3 && typeof message[1] === 'string' && typeof message[2] === 'string'
  if (op === 'OK') return message.length >= 3 && typeof message[1] === 'string' && typeof message[2] === 'boolean'
  if (op === 'NOTICE') return message.length >= 2 && typeof message[1] === 'string'
  if (op === 'AUTH') return message.length === 2 && typeof message[1] === 'string'
  if (op === 'COUNT') return message.length === 3 && typeof message[1] === 'string' && Number.isSafeInteger(message[2]?.count) && message[2].count >= 0
  if (op === 'NEG-MSG') return message.length === 3 && typeof message[1] === 'string' && typeof message[2] === 'string'
  if (op === 'NEG-ERR') return message.length === 3 && typeof message[1] === 'string' && typeof message[2] === 'string'
  return false
}

export function parseNostrFrame (data) {
  if (typeof data !== 'string') return null
  try {
    const message = JSON.parse(data)
    return Array.isArray(message) && typeof message[0] === 'string' ? message : null
  } catch {
    return null
  }
}

export function isStrictNostrFrame (data, direction) {
  if (typeof data !== 'string') return false
  let message
  try {
    message = JSON.parse(data)
  } catch {
    return false
  }
  if (!Array.isArray(message) || typeof message[0] !== 'string') return false
  const ops = direction === 'client' ? CLIENT_OPS : SERVER_OPS
  if (!ops.has(message[0])) return false
  return direction === 'client' ? matchesClientShape(message) : matchesServerShape(message)
}
