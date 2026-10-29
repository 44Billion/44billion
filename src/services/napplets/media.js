import { createBrowserMediaBridge } from '@kehto/services'

const bridges = new WeakMap()

// OS controls are shared by every app in this document. Namespace caller-chosen
// IDs and keep teardown/action delivery confined to the owning frame.
export function scopedMediaBridge (owner, host) {
  let shared = bridges.get(host)
  if (!shared) {
    shared = { bridge: createBrowserMediaBridge({ mediaSessionTarget: host.navigator.mediaSession, documentTarget: host.document }), activeOwner: null }
    bridges.set(host, shared)
  }
  const { bridge } = shared
  const sessions = new Map()
  const key = id => { const scoped = `${owner}:${id}`; sessions.set(id, scoped); return scoped }
  return {
    setMetadata (id, metadata) { bridge.setMetadata(key(id), metadata) },
    setPlaybackState (id, state) { if (sessions.has(id)) bridge.setPlaybackState(sessions.get(id), state) },
    onAction: callback => bridge.onAction((scoped, ...args) => { for (const [id, key] of sessions) if (key === scoped) callback(id, ...args) }),
    setActiveSession (id, actions) {
      if (id) { shared.activeOwner = owner; bridge.setActiveSession(key(id), actions) } else if (shared.activeOwner === owner) { shared.activeOwner = null; bridge.setActiveSession(null) }
    },
    destroySession (id) { const scoped = sessions.get(id); if (sessions.delete(id)) bridge.destroySession(scoped) }
  }
}
