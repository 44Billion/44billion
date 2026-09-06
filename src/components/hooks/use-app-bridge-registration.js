import { useStore, useTask } from '#f'
import { ensureAppBridgeState, registerAppBridgeWindow } from '#helpers/window-message/app-bridge-registry.js'

// Membership lasts for the instance identity, independently of document
// handshakes, errors and retries. Otherwise a ready notification can unregister
// the last window and destroy the very bridge it is about to use.
export default function useAppBridgeRegistration (getIdentity, createEntry) {
  const store = useStore({ bridgeState$: null })
  useTask(({ track, cleanup }) => {
    const identity = track(getIdentity)
    if (!identity) return
    const { appSubdomain, userPk, appId } = identity
    if (appSubdomain == null || !userPk || !appId) return
    const state = ensureAppBridgeState(appSubdomain, { userPk, appId })
    const unregister = registerAppBridgeWindow(state, createEntry(identity))
    cleanup(() => {
      store.bridgeState$(null) // disconnect the document before removing its bridge
      unregister()
    })
    store.bridgeState$(state)
  })
  return store.bridgeState$
}
