// MessagePort preserves delivery order, but async event handlers can overlap.
// Serialize account-state applications so CLOSE_VAULT_VIEW can acknowledge
// immediately, then wait for every earlier SET_ACCOUNTS_STATE before closing
// and emitting the one-shot first-account attention signal. Generation checks
// keep work from a replaced vault document from committing later.
export function createAccountStateCoordinator ({
  applyAccountsState,
  closeVault,
  emitFirstAccountAttention,
  isVaultOpen = () => true,
  onError = err => console.warn('Failed to apply vault account state', err)
}) {
  let pendingApplication = Promise.resolve()
  let pendingAttention = null

  const apply = (accounts, { allowAttention = false, isCurrent = () => true } = {}) => {
    pendingApplication = pendingApplication
      .then(async () => {
        if (!isCurrent()) return
        const metadata = await applyAccountsState(accounts, { isCurrent })
        if (metadata === false || !isCurrent()) return
        if (allowAttention && metadata?.activatedFirstAccount) {
          if (isVaultOpen()) {
            pendingAttention = metadata
          } else {
            // Compatibility with vault versions that posted CLOSE before the
            // account-state microtask. Current EZ Vault flushes state first,
            // but deployed/cached versions may retain the old ordering.
            emitFirstAccountAttention(metadata)
          }
        }
      })
      .catch(onError)
    return pendingApplication
  }

  const close = async ({ isCurrent = () => true } = {}) => {
    await pendingApplication
    if (!isCurrent()) return
    closeVault()
    if (!pendingAttention) return
    const attention = pendingAttention
    pendingAttention = null
    emitFirstAccountAttention(attention)
  }

  return { apply, close }
}
