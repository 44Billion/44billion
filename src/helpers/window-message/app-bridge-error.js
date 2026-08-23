export const APP_BRIDGE_ERROR_KIND = Object.freeze({
  BRIDGE: 'bridge',
  APP_PAGE: 'app-page',
  FILE: 'file'
})

export function normalizeAppBridgeError (details) {
  if (typeof details === 'string') {
    return {
      pathname: details,
      kind: APP_BRIDGE_ERROR_KIND.FILE
    }
  }
  return {
    ...(details || {}),
    kind: details?.kind || APP_BRIDGE_ERROR_KIND.FILE
  }
}

export function isAppBridgeCommunicationError (details) {
  const kind = normalizeAppBridgeError(details).kind
  return kind === APP_BRIDGE_ERROR_KIND.BRIDGE ||
    kind === APP_BRIDGE_ERROR_KIND.APP_PAGE
}

export function isCriticalAppFile (pathname) {
  return pathname === undefined || /^\/?index\.html?$/.test(pathname || '')
}

export function isRetryableAppBridgeError (error) {
  return error?.kind === APP_BRIDGE_ERROR_KIND.BRIDGE ||
    error?.code === 'APP_BRIDGE_UNAVAILABLE' ||
    error?.code === 'STREAM_TIMEOUT' ||
    error?.code === 'APP_BRIDGE_RETRY'
}

export function tagAppBridgeFileError (error) {
  const normalized = error instanceof Error
    ? error
    : new Error(String(error ?? 'App file error'))
  normalized.context = {
    ...(normalized.context || {}),
    kind: APP_BRIDGE_ERROR_KIND.FILE
  }
  return normalized
}
