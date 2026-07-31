let replaceHandler = null

export function registerManifestInstanceReplaceHandler (handler) {
  replaceHandler = typeof handler === 'function' ? handler : null
}

export async function replaceCachedSiteManifest (appId, manifest) {
  return replaceHandler?.(appId, manifest) ?? null
}
