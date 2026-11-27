export function createVaultAuthorityState () {
  let authoritative = false
  return {
    hasAuthoritativeState: () => authoritative,
    markAuthoritative () { authoritative = true }
  }
}

export const vaultAuthority = createVaultAuthorityState()
