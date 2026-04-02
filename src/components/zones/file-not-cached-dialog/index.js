import { f, useGlobalStore, useStore, useCallback, useTask } from '#f'
import { cssStrings, cssClasses, cssVars, jsVars } from '#assets/styles/theme.js'
import '#shared/modal.js'
import '#shared/icons/icon-x.js'
import '#shared/icons/icon-reload.js'
import '#shared/icons/icon-exclamation-mark.js'

const cancelError = err => (err = new Error('File not cached action canceled')) && (err.code = 'CANCELED') && err
const closedError = err => (err = new Error('File not cached dialog closed')) && (err.code = 'CANCELED') && err
const supersededError = () => new Error('File not cached request superseded')

// const { requestAction } = useGlobalStore('<file-not-cached-dialog>')
// try {
//   await requestAction({ appName: 'My App' })
//   // user clicked Retry — re-open the app
// } catch {
//   // user clicked Cancel — delete the app
// }
f('fileNotCachedDialog', function () {
  const store = useGlobalStore('<file-not-cached-dialog>', () => ({
    currentRequest$: null,
    lastRequest$: null,
    isOpen$ () { return Boolean(this.currentRequest$()) },
    appName$ () { return (this.currentRequest$() ?? this.lastRequest$())?.appName ?? 'App Download' },
    message$ () { return (this.currentRequest$() ?? this.lastRequest$())?.message ?? 'Failed to load app. Retry or remove it?' },
    resolveRetry () {
      const req = this.currentRequest$()
      if (!req) return
      this.lastRequest$(req)
      this.currentRequest$(null)
      req.resolve()
    },
    rejectCancel (error = cancelError()) {
      const req = this.currentRequest$()
      if (!req) return
      this.lastRequest$(req)
      this.currentRequest$(null)
      req.reject(error)
    },
    close () { this.rejectCancel(closedError()) },
    requestAction ({ appName, message }) {
      const pending = this.currentRequest$()
      if (pending) pending.reject(supersededError())

      const { promise, resolve, reject } = Promise.withResolvers()
      this.currentRequest$({ appName, message, resolve, reject })
      return promise
    }
  }))
  const modalProps = useStore(() => ({
    isOpen$: store.isOpen$,
    close: store.close.bind(store),
    shouldAlwaysDisplay$: true,
    render: useCallback(function () {
      return this.h`<file-not-cached-dialog-card />`
    })
  }))
  return this.h`<a-modal props=${modalProps} />`
})

f('fileNotCachedDialogCard', function () {
  const store = useGlobalStore('<file-not-cached-dialog>')
  const local = useStore(() => ({
    isButtonsDisabled$: false,
    appName$: store.appName$,
    message$: store.message$,
    retry () {
      if (this.isButtonsDisabled$()) return
      this.isButtonsDisabled$(true)
      store.resolveRetry()
    },
    cancel () {
      if (this.isButtonsDisabled$()) return
      this.isButtonsDisabled$(true)
      store.rejectCancel()
    }
  }))

  useTask(({ track }) => {
    track(() => store.currentRequest$())
    local.isButtonsDisabled$(false)
  })

  return this.h`
    <style>${/* css */`
      #file-not-cached-dialog-card {
        &${cssStrings.defaultTheme}

        display: flex;
        align-items: center;
        padding: 6px 10px;
        min-width: 220px;
        border-radius: 8px;
        background-color: ${cssVars.colors.bg2Lighter};
        color: ${cssVars.colors.fg2};
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);

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
          color: rgba(255, 255, 255, 0.7);
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

        .cancel-button {
          background-color: transparent;
          color: ${cssVars.colors.fg2};
          width: 36px;
          height: 36px;
          justify-content: center;
          padding: 0;
        }

        .cancel-button:hover:not(:disabled) {
          background-color: rgba(255, 255, 255, 0.08);
        }

        icon-reload,
        icon-x {
          display: flex;
        }
      }
    `}</style>
    <div id='file-not-cached-dialog-card' class=${cssClasses.defaultTheme}>
      <div class='icon-area'>
        <icon-exclamation-mark props=${{ width: '33px', height: '36px' }} />
      </div>
      <div class='info-area'>
        <div class='title'>${local.appName$()}</div>
        <div class='message'>${local.message$()}</div>
      </div>
      <div class='actions'>
        <button
          class='retry-button'
          onclick=${local.retry}
          disabled=${local.isButtonsDisabled$()}
        >
          <icon-reload props=${{ size: '16px' }} />
          <span>Retry</span>
        </button>
        <button
          class='cancel-button'
          onclick=${local.cancel}
          disabled=${local.isButtonsDisabled$()}
        >
          <icon-x props=${{ size: '16px' }} />
        </button>
      </div>
    </div>
  `
})
