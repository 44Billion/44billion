// Session-only cache for blossom direct-URL icon fallbacks.
//
// Those fallbacks are returned with `persistable: false` so they never reach
// localStorage and never become the durable choice for a future session.
// Remounting an app-icon in the same tab, however, should reuse the already
// resolved URL instead of repeating the same network resolution and showing
// the shimmer again.
//
// The primary map is keyed by appId + manifestId, as requested. A secondary
// appId alias exists because the app-icon cache task runs before the site
// manifest is available, so it cannot compute manifestId synchronously.

const directIconsByManifest = new Map()
const directIconsByAppId = new Map()

function getManifestKey (appId, manifestId) {
  return `${appId}\u0000${manifestId ?? ''}`
}

export function cacheDirectIconFallback ({ appId, manifestId, icon }) {
  if (!appId || !icon?.url) return icon

  directIconsByManifest.set(getManifestKey(appId, manifestId), icon)
  directIconsByAppId.set(appId, {
    manifestId: manifestId ?? null,
    icon
  })
  return icon
}

export function getDirectIconFallback ({ appId, manifestId }) {
  if (!appId) return null
  return directIconsByManifest.get(getManifestKey(appId, manifestId)) ?? null
}

export function getDirectIconFallbackByAppId (appId) {
  if (!appId) return null
  return directIconsByAppId.get(appId)?.icon ?? null
}
