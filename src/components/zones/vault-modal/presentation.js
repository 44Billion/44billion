export const LEGACY_VAULT_URL = 'https://44billion.github.io/44b-vault'
export const EZ_VAULT_URL = 'https://44billion.github.io/ez-vault'

export function normalizeVaultUrl (value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const url = new URL(value.trim())
    if (url.username || url.password || url.search || url.hash) return url.href
    const pathname = url.pathname.replace(/\/+$/, '')
    return `${url.origin}${pathname}`
  } catch {
    return value.trim().replace(/\/+$/, '')
  }
}

export function isLegacyVaultUrl (value) {
  return normalizeVaultUrl(value) === LEGACY_VAULT_URL
}

export function isSameVaultUrl (left, right) {
  return normalizeVaultUrl(left) === normalizeVaultUrl(right)
}

export function drawerPositionAtOpen (
  matchMedia = globalThis.matchMedia?.bind(globalThis)
) {
  return matchMedia?.('(orientation: portrait)').matches ? 'start' : 'end'
}

export function shouldShowVaultMigration ({
  vaultUrl,
  connectedVaultUrl,
  vaultPort,
  isOpen
}) {
  return Boolean(
    vaultPort &&
    !isOpen &&
    isLegacyVaultUrl(vaultUrl) &&
    isLegacyVaultUrl(connectedVaultUrl)
  )
}
