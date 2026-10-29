import { createRuntime } from '@kehto/runtime'
import { originRegistry, prepareNappletSrcdoc } from '@kehto/shell'
import { createThemeService } from '@kehto/services'
import { verifyEvent } from '../event-verification.js'
import { NAPPLET_DOMAINS } from '#helpers/napplet.js'
import { defaultThemeColorValues } from '#assets/styles/theme.js'
import { createNappletStatePersistence } from './storage.js'
import { createNappletAccount } from './account.js'
import { createNappletNetwork } from './network.js'
import { installIntentLinks } from './intent-links.js'
import { createNappletServices } from './services.js'

const ephemeral = () => ({ load: () => null, persist: () => {} })

export function getNappletTheme (dark) {
  const mode = dark ? 'dark' : 'light'
  return {
    title: '44billion',
    colors: {
      background: defaultThemeColorValues.bg[mode],
      text: defaultThemeColorValues.fg[mode],
      primary: defaultThemeColorValues.bgPrimary[mode]
    }
  }
}

// Kehto's default browser bridge has global, account-independent WebStorage
// backends. Use its protocol engine and document/registry helpers with explicit
// launcher-owned persistence instead. Never use the legacy AUTH/keypair path.
export function mountNapplet ({ iframe, resolved, appId, userPk, wsKey, askVault, requestPermission, openLink, intents, appKey, host = window, storage = localStorage }) {
  const source = iframe.contentWindow
  if (!source) throw new Error('Napplet frame unavailable')
  const windowId = crypto.randomUUID()
  let alive = true
  let initialized = false
  const controller = new AbortController()
  const signal = controller.signal
  const state = createNappletStatePersistence(userPk, appId, storage)
  const account = createNappletAccount({ appId, userPk, wsKey, name: resolved.manifest.title || resolved.dTag || 'Napplet', signal, storage, askVault, requestPermission })
  const network = createNappletNetwork({ account, signal })
  const backends = createNappletServices({ account, network, state, signal, iframe, windowId, name: resolved.manifest.title || resolved.dTag || 'Napplet', resolved, host, openLink })
  const domains = NAPPLET_DOMAINS.filter(domain => ['shell', 'storage', 'theme'].includes(domain) || backends.services[domain])
  const send = (_id, envelope) => { if (alive) source.postMessage(envelope, '*') }
  const intent = intents?.service({ windowId, appKey, event: resolved.event, send: envelope => send(windowId, envelope), guard: account.guard })
  if (intent) domains.push('intent')
  const media = host.matchMedia('(prefers-color-scheme: dark)')
  const theme = createThemeService({ initialTheme: getNappletTheme(media.matches), onBroadcast: envelope => send(windowId, envelope) })
  const runtime = createRuntime({
    sendToNapplet: send,
    isDomainAllowed: (id, domain) => alive && id === windowId && domains.includes(domain),
    auth: { getUserPubkey: account.getPublicKey, getSigner: () => ({ getPublicKey: async () => account.getPublicKey() || '', getRelays: network.getRelays, signEvent: account.signEvent }) },
    config: { getNappUpdateBehavior: () => 'banner' },
    hotkeys: { executeHotkeyFromForward: event => backends.services.keys.handleMessage(windowId, { type: 'keys.forward', ...event }, () => {}) },
    crypto: { verifyEvent: async event => verifyEvent(event), randomUUID: () => crypto.randomUUID(), randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) },
    aclPersistence: ephemeral(),
    manifestPersistence: ephemeral(),
    statePersistence: state,
    windowManager: { createWindow: () => null },
    relayConfig: { addRelay: () => {}, removeRelay: () => {}, getRelayConfig: () => ({ discovery: [], super: [], outbox: [] }), getNip66Suggestions: () => [] },
    services: { ...backends.services, ...(intent ? { intent: intent.service } : {}), theme: theme.handler }
  })
  const identity = { dTag: resolved.dTag, aggregateHash: resolved.aggregateHash }
  const environment = { capabilities: { domains }, services: [...Object.keys(backends.services), 'theme', ...(intent ? ['intent'] : [])] }
  let srcdoc = prepareNappletSrcdoc(resolved.indexHtml, { domains })
  // Append to the injected prelude, preserving the original doctype/head order.
  if (intent) srcdoc = srcdoc.replace('</script>', end => `${end}<script>(${installIntentLinks.toString()})()</script>`)
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; usb 'none'; hid 'none'; gamepad 'none'; clipboard-read 'none'; clipboard-write 'none'")
  originRegistry.register(source, windowId, identity)
  originRegistry.setEnvironment(source, environment)
  runtime.sessionRegistry.register(windowId, {
    ...identity, pubkey: '', windowId, origin: 'null', type: 'nip5d', registeredAt: Date.now(), instanceId: windowId, provenance: 'nip-5d'
  })
  const handleMessage = event => {
    if (!alive || event.source !== source || event.origin !== 'null' || originRegistry.getWindowId(source) !== windowId) return
    const message = event.data
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return
    if (message.type === 'shell.ready') {
      if (!initialized) { initialized = true; send(windowId, { type: 'shell.init', ...environment }); intent?.ready() }
      return
    }
    runtime.handleMessage(windowId, message)
  }
  const updateTheme = () => theme.publishTheme(getNappletTheme(media.matches))
  host.addEventListener('message', handleMessage)
  media.addEventListener('change', updateTheme)
  iframe.srcdoc = srcdoc
  return () => {
    if (!alive) return
    alive = false
    controller.abort()
    intent?.close()
    host.removeEventListener('message', handleMessage)
    media.removeEventListener('change', updateTheme)
    runtime.destroyWindow(windowId)
    runtime.sessionRegistry.unregister(windowId)
    originRegistry.unregister(windowId)
    runtime.destroy()
    backends.close()
    network.close()
    iframe.removeAttribute('srcdoc')
    iframe.src = 'about:blank'
  }
}
