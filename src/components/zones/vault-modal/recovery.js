import { f, useGlobalStore, useStore, useCallback, useTask } from '#f'
import '#shared/modal.js'
import '#shared/icons/icon-reload.js'
import '#shared/icons/icon-exclamation-mark.js'
import { cssVars, jsVars } from '#assets/styles/theme.js'
import { getT } from '#i18n/index.js'
import { createVaultRecoveryStore } from './recovery-store.js'
import { vaultModalLocales } from './locales.js'

const t = getT(vaultModalLocales)

export function useVaultRecoveryStore () {
  return useGlobalStore('vaultRecovery', () => createVaultRecoveryStore(t))
}

// const { requestAction } = useVaultRecoveryStore()
// try {
//   await requestAction({ title: 'Vault', message: 'Vault failed to start. Retry?' })
//   // user clicked Retry (or closed via ESC/backdrop) — reload the vault iframe
// } catch {
//   // the vault recovered on its own (VAULT_READY arrived) — nothing to do
// }
f('vaultReloadDialog', function () {
  const store = useVaultRecoveryStore()
  const modalProps = useStore(() => ({
    isOpen$: store.isOpen$,
    close: store.close.bind(store),
    shouldAlwaysDisplay$: true,
    render: useCallback(function () {
      return this.h`<vault-reload-dialog-card />`
    })
  }))
  return this.h`<a-modal props=${modalProps} />`
})

f('vaultReloadDialogCard', function () {
  const store = useVaultRecoveryStore()
  const local = useStore(() => ({
    isButtonsDisabled$: false,
    title$: store.title$,
    message$: store.message$,
    retry () {
      if (this.isButtonsDisabled$()) return
      this.isButtonsDisabled$(true)
      store.resolveRetry()
    }
  }))

  useTask(({ track }) => {
    track(() => store.currentRequest$())
    local.isButtonsDisabled$(false)
  })

  return this.h`
    <style>${/* css */`
      #vault-reload-dialog-card {
        display: flex;
        align-items: center;
        padding: 6px 10px;
        min-width: 220px;
        border-radius: 8px;
        background-color: ${cssVars.colors.bg2Lighter};
        color: ${cssVars.colors.fg2};
        box-shadow: 0 4px 12px ${cssVars.colors.shadow};

        @media ${jsVars.breakpoints.desktop} {
          margin: 0 auto;
          max-width: 600px;
        }
        @media ${jsVars.breakpoints.mobile} {
          border-radius: 0;
          width: 100%;
        }

        .icon-area {
          margin-right: 12px;
          flex-shrink: 0;
          width: 40px;
          height: 40px;
          border-radius: 10px;
          color: ${cssVars.colors.bg4};
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .info-area {
          flex: 1;
          min-width: 0;
          margin-right: 20px;
          top: 1px;
          position: relative;
        }

        .title {
          font-size: 15rem;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .message {
          font-size: 16rem;
          line-height: 1.3;
          color: ${cssVars.colors.fgMuted};
          margin-top: 2px;
          white-space: normal;
          overflow-wrap: anywhere;
        }

        .actions {
          display: flex;
          gap: 8px;
          flex-shrink: 0;
        }

        button {
          border: none;
          border-radius: 6px;
          padding: 6px 12px;
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 14rem;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 0.2s, opacity 0.2s;
        }

        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .retry-button {
          background-color: ${cssVars.colors.bgAccentPrimary};
          color: ${cssVars.colors.fgAccent};
        }

        .retry-button:hover:not(:disabled) {
          background-color: ${cssVars.colors.bgPrimary};
        }

        icon-reload {
          display: flex;
        }
      }
    `}</style>
    <div id='vault-reload-dialog-card'>
      <div class='icon-area'>
        <icon-exclamation-mark props=${{ width: '33px', height: '36px' }} />
      </div>
      <div class='info-area'>
        <div class='title'>${local.title$()}</div>
        <div class='message'>${local.message$()}</div>
      </div>
      <div class='actions'>
        <button
          class='retry-button'
          onclick=${local.retry}
          disabled=${local.isButtonsDisabled$()}
        >
          <icon-reload props=${{ size: '16px' }} />
          <span>${t('Retry')}</span>
        </button>
      </div>
    </div>
  `
})
