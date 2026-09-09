// Development classification is local to the launcher, never a Nostr event tag.
export const LOCAL_DEV_KEY = 'local_devApps'

export function readLocalApps (storage = globalThis.localStorage) {
  if (typeof IS_DEVELOPMENT === 'undefined' || !IS_DEVELOPMENT) return {}
  try {
    const value = JSON.parse(storage?.getItem(LOCAL_DEV_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

export function isLocalDevApp (appId, storage) {
  return Object.hasOwn(readLocalApps(storage), appId)
}

export function writeLocalApp (appId, value, storage = localStorage) {
  const records = readLocalApps(storage)
  if (value) records[appId] = value
  else delete records[appId]
  storage.setItem(LOCAL_DEV_KEY, JSON.stringify(records))
}

export const installLock = _appId => 'local-dev:install'
export const versionLock = (appId, version) => `local-dev:version:${appId}:${version}`
export const userLock = (appId, userPk) => `local-dev:user:${appId}:${userPk}`
