import { f, useStore, useCallback, useComputed } from '#f'
import { cssVars, jsVars } from '#assets/styles/theme.js'
import '#shared/modal.js'
import '#shared/icons/icon-x.js'
import '#shared/icons/icon-reload.js'
import { getT } from '#i18n/index.js'
import { launcherUpdateLocales } from '#i18n/launcher-update.js'
import {
  applyLauncherUpdate,
  dismissLauncherUpdate,
  launcherUpdateState$
} from '#helpers/launcher-sw-manager.js'

const t = getT(launcherUpdateLocales)

// Mounted by the launcher zones (multi-napp / single-napp) next to the other
// dialogs. It mirrors the confirmation-dialog pattern: a shared <a-modal>
// driven by the launcher-update state signal, so the plain-JS sw manager can
// open it without living inside the component tree.
f('launcher-update-dialog', function () {
  const isOpen$ = useComputed(() => launcherUpdateState$() === 'available')
  const modalProps = useStore(() => ({
    isOpen$,
    // Closing the modal (X, ESC or backdrop) dismisses the update prompt and
    // hands over to the persistent toolbar-more-menu indicators.
    close: dismissLauncherUpdate,
    shouldAlwaysDisplay$: true,
    render: useCallback(function () {
      return this.h`<launcher-update-dialog-card />`
    })
  }))

  return this.h`<a-modal props=${modalProps} />`
})

f('launcher-update-dialog-card', function () {
  return this.h`
    <style>${/* css */`
      #launcher-update-dialog-card {
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
          max-width: 420px;
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
        }

        .title {
          font-size: 15rem;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
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

        .confirm-button {
          background-color: ${cssVars.colors.bgAccentPrimary};
          color: ${cssVars.colors.fgAccent};
        }

        .confirm-button:hover {
          background-color: ${cssVars.colors.bgPrimary};
        }

        .dismiss-button {
          background-color: transparent;
          color: ${cssVars.colors.fg2};
          width: 36px;
          height: 36px;
          justify-content: center;
          padding: 0;
        }

        .dismiss-button:hover {
          background-color: ${cssVars.colors.overlayHover};
        }
      }
    `}</style>
    <div id='launcher-update-dialog-card'>
      <div class='icon-area'><icon-reload props=${{ size: '24px' }} /></div>
      <div class='info-area'>
        <div class='title'>${t('New version available')}</div>
      </div>
      <div class='actions'>
        <button class='confirm-button' onclick=${applyLauncherUpdate}>${t('Update')}</button>
        <button class='dismiss-button' aria-label=${t('Dismiss')} onclick=${dismissLauncherUpdate}><icon-x props=${{ size: '16px' }} /></button>
      </div>
    </div>
  `
})
