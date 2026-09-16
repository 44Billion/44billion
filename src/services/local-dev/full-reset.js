import { writePendingFullReset } from './boot-reset.js'

// App origins this launcher may have stored data in: live mappings plus
// quarantined ids the subdomain lifecycle still needs to clean.
export function readKnownAppSubdomains (localStorageArea = globalThis.localStorage) {
  const ids = new Set()
  try {
    for (let index = 0; index < (localStorageArea?.length ?? 0); index++) {
      const key = localStorageArea.key(index)
      if (typeof key !== 'string') continue
      if (key.startsWith('session_subdomainToApp_')) {
        ids.add(key.slice('session_subdomainToApp_'.length))
      } else if (key.startsWith('session_subdomainByUserAndApp_')) {
        const value = JSON.parse(localStorageArea.getItem(key))
        if (typeof value === 'string' && /^\d+$/.test(value)) ids.add(value)
      }
    }
    const lifecycle = JSON.parse(localStorageArea?.getItem?.('local_subdomainLifecycle') || 'null')
    for (const id of lifecycle?.pending ?? []) ids.add(String(id))
    for (const id of Object.keys(lifecycle?.assignments ?? {})) ids.add(id)
  } catch {
    // A corrupt mapping must not block the reset; the launcher wipe still runs.
  }
  return [...ids].filter(id => /^\d+$/.test(id)).sort((a, b) => Number(a) - Number(b))
}

async function pauseLocalInstances () {
  const { notifyLocalInstances } = await import('./instances.js')
  notifyLocalInstances({ type: 'pause' })
}

async function clearAppOrigin (appSubdomain) {
  const { askAppToClearData } = await import('#zones/screen/helpers/draft-app-runtime-reset.js')
  await askAppToClearData(appSubdomain, { strict: true, localDevelopment: true })
}

// Confirmed development-only reset. The vault is the account authority, so a
// vault that cannot be wiped aborts the whole action: reloading into a
// "cleared" launcher that the vault refills with the same accounts is exactly
// the confusion this reset exists to remove.
export async function requestLocalDevFullReset ({
  localStorageArea = globalThis.localStorage,
  askVault,
  reload = () => globalThis.location?.reload?.(),
  resetUrl = () => globalThis.history?.replaceState?.(null, '', '/'),
  pauseInstances = pauseLocalInstances,
  clearOrigin = clearAppOrigin,
  warn = (...args) => console.warn(...args)
} = {}) {
  if (typeof askVault !== 'function') throw new Error('Vault is not connected')

  const subdomains = readKnownAppSubdomains(localStorageArea)
  try {
    await pauseInstances()
  } catch (error) {
    warn('[local-dev] Could not pause local instances before the full reset', error)
  }

  const response = await askVault({ code: 'LOCAL_DEV_WIPE', payload: null }, { timeout: 30000 })
  if (response?.error) throw response.error

  const failures = []
  for (const subdomain of subdomains) {
    try {
      await clearOrigin(subdomain)
    } catch (error) {
      failures.push({ step: 'app origin', subdomain, message: error?.message ?? String(error) })
      warn(`[local-dev] Could not clear app origin ${subdomain}`, error)
    }
  }

  // The next boot starts at the launcher root instead of reopening an app
  // window whose files and user were just deleted.
  try {
    resetUrl()
  } catch (error) {
    warn('[local-dev] Could not reset the launcher URL before reloading', error)
  }
  writePendingFullReset(localStorageArea)
  reload()
  return { subdomains, failures }
}
