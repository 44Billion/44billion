import { f, useGlobalStore, useStore, useCallback } from '#f'
import { cssVars, jsVars } from '#assets/styles/theme.js'
import '#shared/modal.js'
import '#shared/icons/icon-x.js'
import '#shared/icons/icon-info-hexagon-filled.js'
import { getT } from '#i18n/index.js'
import { createInfoDialogStore } from './store.js'

// Informational counterpart of the confirmation dialog: same card layout with
// a single dismiss (X) action, for messages that are not a question. Callers
// pass the copy, so this module only translates its own chrome.
export const infoDialogLocales = {
  Dismiss: {
    en: 'Dismiss',
    fr: 'Ignorer',
    it: 'Ignora',
    de: 'Schließen',
    es: 'Descartar',
    'pt-BR': 'Dispensar',
    ru: 'Скрыть',
    'zh-CN': '关闭',
    'zh-TW': '關閉',
    ja: '閉じる',
    ko: '닫기'
  }
}
const t = getT(infoDialogLocales)

export function useInfoDialogStore () {
  return useGlobalStore('<info-dialog>', createInfoDialogStore)
}

// const { showInfo } = useInfoDialogStore()
// showInfo({ title: 'Development reset', message: 'Could not clear the vault.' })
f('info-dialog', function () {
  const store = useInfoDialogStore()
  const modalProps = useStore(() => ({
    isOpen$: store.isOpen$,
    close: store.close.bind(store),
    shouldAlwaysDisplay$: true,
    render: useCallback(function () {
      return this.h`<info-dialog-card />`
    })
  }))

  return this.h`<a-modal props=${modalProps} />`
})

f('info-dialog-card', function () {
  const store = useInfoDialogStore()

  return this.h`
    <style>${/* css */`
      #info-dialog-card {
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
          position: relative;
          overflow: hidden;
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

        icon-x {
          display: flex;
        }
      }
    `}</style>
    <div id='info-dialog-card'>
      <div class='icon-area'>
        <icon-info-hexagon-filled props=${{ width: '33px', height: '36px' }} />
      </div>
      <div class='info-area'>
        <div class='title'>${store.title$()}</div>
        <div class='message'>${store.message$()}</div>
      </div>
      <div class='actions'>
        <button class='dismiss-button' aria-label=${t('Dismiss')} onclick=${() => store.close()}>
          <icon-x props=${{ size: '16px' }} />
        </button>
      </div>
    </div>
  `
})
