import { f, useGlobalStore, useStore, useCallback, useTask } from '#f'
import { cssStrings, cssClasses, cssVars, jsVars } from '#assets/styles/theme.js'
import '#shared/modal.js'
import '#shared/icons/icon-x.js'
import '#shared/icons/icon-check.js'
import '#shared/icons/icon-help-hexagon-filled.js'

const DEFAULT_TITLE = 'Confirmation'
const DEFAULT_MESSAGE = 'Are you sure?'
const DEFAULT_CONFIRM_TEXT = 'Yes'

const supersededError = () => new Error('Confirmation superseded')
const rejectedError = err => (err = new Error('Confirmation denied')) && (err.code = 'DENIED_BY_USER') && err
const closedError = err => (err = new Error('Confirmation dialog closed')) && (err.code = 'DENIED_BY_USER') && err

// const { requestConfirmation } = useGlobalStore('<confirmation-dialog>')
// try {
//   await requestConfirmation({
//     title: 'Delete Note',
//     message: 'Delete this note?',
//     confirmText: 'Delete'
//   })
//   // proceed with destructive action
// } catch {
//   // user denied or another request superseded it
// }
f('confirmation-dialog', function () {
  const cdStore = useGlobalStore('<confirmation-dialog>', () => ({
    currentRequest$: null,
    isOpen$ () {
      return Boolean(this.currentRequest$())
    },
    title$ () {
      return this.currentRequest$()?.title ?? DEFAULT_TITLE
    },
    message$ () {
      return this.currentRequest$()?.message ?? DEFAULT_MESSAGE
    },
    confirmText$ () {
      return this.currentRequest$()?.confirmText ?? DEFAULT_CONFIRM_TEXT
    },
    resolveCurrent () {
      const req = this.currentRequest$()
      if (!req) return
      this.currentRequest$(null)
      req.resolve(true)
    },
    rejectCurrent (error = rejectedError()) {
      const req = this.currentRequest$()
      if (!req) return
      this.currentRequest$(null)
      req.reject(error)
    },
    close () {
      this.rejectCurrent(closedError())
    },
    requestConfirmation ({ title = DEFAULT_TITLE, message = DEFAULT_MESSAGE, confirmText = DEFAULT_CONFIRM_TEXT } = {}) {
      const pending = this.currentRequest$()
      if (pending) pending.reject(supersededError())

      const { promise, resolve, reject } = Promise.withResolvers()
      this.currentRequest$({ title, message, confirmText, resolve, reject })
      return promise
    }
  }))
  const modalProps = useStore(() => ({
    isOpen$: cdStore.isOpen$,
    close: cdStore.close.bind(cdStore),
    shouldAlwaysDisplay$: true,
    render: useCallback(function () {
      // return this.h`<div>test</div>`
      return this.h`<confirmation-dialog-card />`
    })
  }))

  return this.h`<a-modal props=${modalProps} />`
})

f('confirmation-dialog-card', function () {
  const cdStore = useGlobalStore('<confirmation-dialog>')
  const localStore = useStore(() => ({
    isButtonsDisabled$: false,
    title$: cdStore.title$,
    message$: cdStore.message$,
    confirmText$: cdStore.confirmText$,
    confirm () {
      if (this.isButtonsDisabled$()) return
      this.isButtonsDisabled$(true)
      cdStore.resolveCurrent()
    },
    deny () {
      if (this.isButtonsDisabled$()) return
      this.isButtonsDisabled$(true)
      cdStore.rejectCurrent()
    }
  }))

  useTask(({ track }) => {
    track(() => cdStore.currentRequest$())
    localStore.isButtonsDisabled$(false)
  })

  return this.h`
    <style>${/* css */`
      #confirmation-dialog-card {
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
          position: relative;
          overflow: hidden;
          border-radius: 10px;
          /* background-color: ${cssVars.colors.bgAvatar}; */
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

        .confirm-button {
          background-color: ${cssVars.colors.bgAccentPrimary};
          color: ${cssVars.colors.fgAccent};
        }

        .confirm-button:hover:not(:disabled) {
          background-color: ${cssVars.colors.bgPrimary};
        }

        .deny-button {
          background-color: transparent;
          color: ${cssVars.colors.fg2};
          width: 36px;
          height: 36px;
          justify-content: center;
          padding: 0;
        }

        .deny-button:hover:not(:disabled) {
          background-color: rgba(255, 255, 255, 0.08);
        }

        icon-check,
        icon-x {
          display: flex;
        }
      }
    `}</style>
    <div id='confirmation-dialog-card' class=${cssClasses.defaultTheme}>
      <div class='icon-area'>
        <icon-help-hexagon-filled props=${{ width: '33px', height: '36px' }} />
      </div>
      <div class='info-area'>
        <div class='title'>${localStore.title$()}</div>
        <div class='message'>${localStore.message$()}</div>
      </div>
      <div class='actions'>
        <button
          class='confirm-button'
          onclick=${localStore.confirm}
          disabled=${localStore.isButtonsDisabled$()}
        >
          <icon-check props=${{ size: '16px' }} />
          <span>${localStore.confirmText$()}</span>
        </button>
        <button
          class='deny-button'
          onclick=${localStore.deny}
          disabled=${localStore.isButtonsDisabled$()}
        >
          <icon-x props=${{ size: '16px' }} />
        </button>
      </div>
    </div>
  `
})
