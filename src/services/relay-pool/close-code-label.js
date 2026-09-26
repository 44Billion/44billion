// RFC 6455 close codes plus the synthetic codes the pool itself uses.
const CLOSE_CODE_LABELS = Object.freeze({
  1000: 'normal closure',
  1001: 'going away',
  1002: 'protocol error',
  1003: 'unsupported data',
  1005: 'no status received',
  1006: 'abnormal closure (no close frame)',
  1007: 'invalid frame payload data',
  1008: 'policy violation',
  1009: 'message too big',
  1010: 'mandatory extension missing',
  1011: 'internal error',
  1012: 'service restart',
  1013: 'try again later',
  1014: 'bad gateway',
  1015: 'TLS handshake failure'
})

export function closeCodeLabel (code) {
  if (typeof code !== 'number') return 'unknown'
  return CLOSE_CODE_LABELS[code] ?? `code ${code}`
}
