// Pure factory for the vault recovery dialog store. Kept free of framework
// imports so it can be unit-tested directly. The dialog is shown when the
// vault iframe loads but VAULT_READY never arrives (or the vault stays
// unreachable for a long time). Without the vault the launcher cannot work
// properly, so there is no "give up" path: Retry (and ESC/backdrop close)
// resolve the request, which reloads the vault; only an actual recovery
// (VAULT_READY arriving) silently dismisses it.

const supersededError = () => new Error('Vault recovery request superseded')

export function createVaultRecoveryStore (t) {
  return {
    currentRequest$: null,
    lastRequest$: null,
    isOpen$ () { return Boolean(this.currentRequest$()) },
    title$ () { return (this.currentRequest$() ?? this.lastRequest$())?.title ?? t('Vault') },
    message$ () { return (this.currentRequest$() ?? this.lastRequest$())?.message ?? t('Vault failed to start. Retry?') },
    resolveRetry () {
      const req = this.currentRequest$()
      if (!req) return
      this.lastRequest$(req)
      this.currentRequest$(null)
      req.resolve()
    },
    rejectDismiss (error = new Error('Vault recovery dismissed')) {
      const req = this.currentRequest$()
      if (!req) return
      this.lastRequest$(req)
      this.currentRequest$(null)
      req.reject(error)
    },
    // ESC/backdrop close is not a way out — retry instead of dismissing.
    close () { this.resolveRetry() },
    // Silent close used when the vault recovers on its own (VAULT_READY
    // arrives while the dialog is open) or a newer request supersedes it.
    dismiss () { this.rejectDismiss(supersededError()) },
    requestAction ({ title, message }) {
      const pending = this.currentRequest$()
      if (pending) pending.reject(supersededError())

      const { promise, resolve, reject } = Promise.withResolvers()
      this.currentRequest$({ title, message, resolve, reject })
      return promise
    }
  }
}
