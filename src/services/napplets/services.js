import { createNappletUploadService } from './uploads.js'
import { confirmNappletUpload, nappletUploads$ } from './ui.js'
import {
  createIdentityService, createOutboxService, createRelayPoolService, createCountService,
  createResourceService, createCommonService, createListsService, createKeysService,
  createGamepadService, browserGamepadOptions, createConfigService, createNotifyService, createLinkService,
  createBrowserMediaPlayback, createMediaService
} from '@kehto/services'
import { freeRelays } from 'libp2r2p/relay'
import { originRegistry } from '@kehto/shell'
import { createNappletResourceResolver, MAX_RESOURCE_BYTES } from './resources.js'
import { createNappletSocial } from './social.js'
import { createNappletLists } from './lists.js'
import { nappletSettings$, nappletBadges$, nappletMedia$, closeNappletUi, presentNappletNotice, dismissNappletNotice } from './ui.js'
import { NAPPLET_CONFIG_STATE_KEY } from '#constants/storage-schema.js'
import { scopedMediaBridge } from './media.js'

export function createNappletServices ({ account, network, state, signal, iframe, windowId, name, resolved, host, openLink }) {
  const social = createNappletSocial({ network, account })
  const signer = { getPublicKey: async () => account.getPublicKey() || '', getRelays: network.getRelays, signEvent: account.signEvent }
  const keysTarget = new EventTarget()
  const isFocused = () => host.document.visibilityState !== 'hidden' && host.document.activeElement === iframe
  const keydown = event => { if (isFocused()) keysTarget.dispatchEvent(new KeyboardEvent('keydown', event)) }
  host.document.addEventListener('keydown', keydown, { signal })
  const keys = createKeysService({ listenerTarget: keysTarget, reservedChords: ['Ctrl+L', 'Ctrl+W', 'Ctrl+T', 'Meta+L', 'Meta+W', 'Meta+T'] })
  const handleKeysMessage = keys.handleMessage.bind(keys)
  keys.handleMessage = (id, message, send) => {
    if (message.type === 'keys.forward' && isFocused()) keysTarget.dispatchEvent(new KeyboardEvent('keydown', { ...message, ctrlKey: message.ctrlKey ?? message.ctrl, altKey: message.altKey ?? message.alt, shiftKey: message.shiftKey ?? message.shift, metaKey: message.metaKey ?? message.meta }))
    handleKeysMessage(id, message, send)
  }
  const config = createConfigService({
    getValues: () => { account.guard(); return JSON.parse(state.get(NAPPLET_CONFIG_STATE_KEY) || '{}') },
    saveValues: (_id, values) => {
      account.guard()
      const data = JSON.stringify(values)
      if (new TextEncoder().encode(data).length > 32768 || !state.set(NAPPLET_CONFIG_STATE_KEY, data)) throw new Error('CONFIG_STORAGE_FAILED')
    },
    openSettings: (_id, _section, context) => {
      account.guard()
      nappletSettings$({ windowId, name, context: { ...context, commit: values => { account.guard(); return context.commit(values) } } })
    },
    onWindowDestroyed: closeNappletUi
  })
  const services = {
    upload: createNappletUploadService({ account, signal, latest: social.latest, present: (status, cancel) => nappletUploads$(items => Object.fromEntries([...Object.entries(items).filter(([id]) => id !== status.uploadId), [status.uploadId, { status, cancel, name, windowId }]].slice(-16))), confirm: options => confirmNappletUpload({ ...options, name, windowId }) }),
    identity: createIdentityService({
      getSigner: () => signer,
      getProfile: async pubkey => pubkey ? (await social.getProfile(pubkey)).profile : null,
      getFollows: async () => (await social.follows()).pubkeys,
      getMutes: async () => (await social.latest(10000))?.tags.filter(tag => tag[0] === 'p').map(tag => tag[1]) || []
    }),
    outbox: createOutboxService({ router: network.router }),
    relay: createRelayPoolService({
      subscribe: (filters, callback, urls) => network.subscribe(filters, urls?.length ? urls : freeRelays, callback),
      publish: async event => {
        const relays = Object.entries(await network.getRelays()).filter(([, flags]) => flags.write).map(([url]) => url)
        const result = await network.publish(event, relays.length ? relays : freeRelays)
        if (!Object.values(result).some(Boolean)) throw new Error('PUBLICATION_FAILED')
      },
      selectRelayTier: () => [...freeRelays], isAvailable: () => !signal.aborted
    }),
    count: createCountService({ count: request => network.count(request.filters) }),
    resource: createResourceService({
      fetch: createNappletResourceResolver({ signal, guard: account.guard, fallbackServers: resolved.manifest.servers }),
      resourceInfo: { schemes: [{ scheme: 'https' }, { scheme: 'http' }, { scheme: 'blossom' }], maxBytes: MAX_RESOURCE_BYTES }
    }),
    common: createCommonService(social),
    lists: createListsService(createNappletLists({ network, account })),
    keys,
    gamepad: createGamepadService(browserGamepadOptions(host, win => originRegistry.getWindowId(win))),
    config: config.handler,
    notify: createNotifyService({
      controls: ['toasts', 'actions', 'badges', 'channels'],
      present: presentation => { account.guard(); presentNappletNotice(name, presentation) },
      dismiss: (id, notificationId) => dismissNappletNotice(id, notificationId),
      setBadge: (id, count) => { account.guard(); nappletBadges$(badges => ({ ...badges, [id]: { name, count } })) },
      registerChannel: () => account.guard(), requestPermission: async () => { account.guard(); return true }, destroyWindow: closeNappletUi
    })
  }
  if (openLink) services.link = createLinkService({ open: async context => { account.guard(); const result = await openLink(context.url); account.guard(); return result } })
  const playback = createBrowserMediaPlayback({ resource: services.resource, document: host.document })
  const media = createMediaService({ playback, hostBridge: scopedMediaBridge(windowId, host), maxSessionsPerWindow: 4 })
  services.media = media
  const stopMedia = media.subscribe(sessions => {
    for (const session of sessions) {
      const element = media.getElement(session.sessionId)
      if (element) element.controls = true
    }
    nappletMedia$(values => ({ ...values, [windowId]: { name, service: media, sessions } }))
  })
  return { services, close () { stopMedia(); media.destroy(); keys.destroy(); closeNappletUi(windowId) } }
}
