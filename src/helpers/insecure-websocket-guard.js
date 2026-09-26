// Napps may hard-code cleartext endpoints (e.g. ws:// relays). The browser
// blocks those handshakes as mixed content and leaves the whole tab marked
// "not secure", which makes Chrome refuse the WebAuthn calls the vault needs.
// Upgrading the URL before the browser's mixed-content check keeps the tab
// secure and lets endpoints that also serve TLS keep working.
const GUARD_INSTALLED = Symbol.for('44billion.insecureWebSocketGuard')

export function upgradeInsecureWebSocketUrl (url, baseUrl) {
  if (typeof url !== 'string') return url
  let parsed
  try {
    parsed = new URL(url, baseUrl)
  } catch {
    return url
  }
  if (isPotentiallyTrustworthyHostname(parsed.hostname)) return url
  if (parsed.protocol === 'ws:') parsed.protocol = 'wss:'
  else if (parsed.protocol === 'http:') parsed.protocol = 'https:'
  else return url
  return parsed.href
}

// localhost/127.0.0.0/8/[::1] are already potentially trustworthy: ws:// there
// is not mixed content and upgrading it would break local development servers.
function isPotentiallyTrustworthyHostname (hostname) {
  return hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127\./.test(hostname)
}

export function installInsecureWebSocketGuard ({ window, document, log }) {
  if (window.location?.protocol !== 'https:') return
  const OriginalWebSocket = window.WebSocket
  if (typeof OriginalWebSocket !== 'function' || OriginalWebSocket[GUARD_INSTALLED]) return
  const GuardedWebSocket = new Proxy(OriginalWebSocket, {
    construct (target, args) {
      if (args.length === 0) return Reflect.construct(target, [], target)
      const [url, ...rest] = args
      const upgradedUrl = upgradeInsecureWebSocketUrl(url, document.baseURI)
      if (upgradedUrl !== url) log?.(url, upgradedUrl)
      return Reflect.construct(target, [upgradedUrl, ...rest], target)
    }
  })
  Object.defineProperty(GuardedWebSocket, GUARD_INSTALLED, { value: true })
  window.WebSocket = GuardedWebSocket
}
