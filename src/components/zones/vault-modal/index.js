import { f, useGlobalStore, useClosestStore, useStore, useTask, useCallback, useComputed, useSignal } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import { tell, ask, reply } from '#helpers/window-message/index.js'
import { setAccountsState } from '#zones/screen/use-init-or-reset-screen.js'
import {
  cancelTrustedVaultNostrDbSubscription,
  closeTrustedVaultNostrDbSubscriptions,
  pruneNostrDbsForVaultAccounts,
  runTrustedVaultNostrDbMethod,
  streamTrustedVaultNostrDbSubscription
} from '#helpers/window-message/browser/vault-nostrdb.js'
import { flushVaultAcceptedMessageQueue } from '#helpers/window-message/browser/vault-accepted-message-queue.js'
import { isNostrDbAppInstalledForOwner } from '#zones/screen/helpers/nostrdb-app-lifecycle.js'
import { getEffectiveLocale, getT, subscribeLocaleChanged } from '#i18n/index.js'
import { useLocaleSignal } from '#i18n/use-locale.js'
import { cssClasses, cssStrings, cssVars } from '#assets/styles/theme.js'
import '#shared/modal.js'
import '#shared/dialog.js'
import {
  EZ_VAULT_URL,
  drawerPositionAtOpen,
  isLegacyVaultUrl,
  isSameVaultUrl,
  shouldShowVaultMigration
} from './presentation.js'
import { vaultModalLocales } from './locales.js'

export { isLegacyVaultUrl } from './presentation.js'

const t = getT(vaultModalLocales)

export function useVaultModalStore (init) {
  if (init) return useVaultModalInit(init)
  return useClosestStore('<a-modal>')
}

function useVaultModalInit (init) {
  return useClosestStore('<a-modal>', init)
}

f('vault-modal', ({ h }) => {
  const locale$ = useLocaleSignal()
  const upstreamStore = useVaultModalStore()
  const storage = useWebStorage(localStorage)
  const { config_vaultUrl$: vaultUrl$ } = storage
  const messengerStore = useVaultMessengerStore({ shouldInit: true })
  // init it even if vault isn't ready yet cause other components may
  // try to use its methods
  useVaultActor(messengerStore.vaultPort$)

  const presentation = useStore(() => ({
    drawerPosition$: drawerPositionAtOpen(),
    drawerNoCloseOnEscape$: false,
    drawerNoCloseOnBackdrop$: false,
    drawerShowCloseButton$: true,
    drawerHeading$: '',
    drawerDescription$: '',
    drawerThemeClass$: cssClasses.defaultTheme,
    drawerStyle$: `
      --a-drawer-width: min(360px, calc(100dvw - 32px));
      --a-dialog-background: ${cssVars.colors.bg};
      --a-dialog-border-color: ${cssVars.colors.mg2};
      --a-dialog-text: ${cssVars.colors.fg};
      --a-dialog-close-background: ${cssVars.colors.bg2Lighter};
      --a-dialog-close-text: ${cssVars.colors.fg2};
    `,
    migrationPendingEzOpen$: false,
    captureDrawerPosition () {
      this.drawerPosition$(drawerPositionAtOpen())
    }
  }))
  const isLegacy$ = useComputed(() => isLegacyVaultUrl(vaultUrl$()))
  const drawerCloseLabel$ = useComputed(() => {
    locale$()
    return t('Close vault')
  })
  const migrationOpen$ = useComputed(() => shouldShowVaultMigration({
    vaultUrl: vaultUrl$(),
    connectedVaultUrl: messengerStore.connectedVaultUrl$(),
    vaultPort: messengerStore.vaultPort$(),
    isOpen: upstreamStore.isOpen$()
  }))

  // Keep the next edge current only while the EZ/custom drawer is closed.
  // Opening removes the listener, freezing the captured edge until close.
  useTask(({ track, cleanup }) => {
    const [isOpen, isLegacy] = track(() => [upstreamStore.isOpen$(), isLegacy$()])
    if (isOpen || isLegacy) return

    const orientation = matchMedia('(orientation: portrait)')
    const capture = () => presentation.captureDrawerPosition()
    capture()
    orientation.addEventListener('change', capture)
    cleanup(() => orientation.removeEventListener('change', capture))
  })

  // Switching from the migration dialog waits for the replacement iframe's
  // own port, rather than mistaking the still-connected legacy port for EZ.
  useTask(({ track }) => {
    const [isPending, vaultUrl, connectedVaultUrl, vaultPort] = track(() => [
      presentation.migrationPendingEzOpen$(),
      vaultUrl$(),
      messengerStore.connectedVaultUrl$(),
      messengerStore.vaultPort$()
    ])
    if (isPending && !isSameVaultUrl(vaultUrl, EZ_VAULT_URL)) {
      presentation.migrationPendingEzOpen$(false)
      return
    }
    if (
      !isPending ||
      !vaultPort ||
      !isSameVaultUrl(vaultUrl, EZ_VAULT_URL) ||
      !isSameVaultUrl(connectedVaultUrl, EZ_VAULT_URL)
    ) return

    presentation.migrationPendingEzOpen$(false)
    presentation.captureDrawerPosition()
    upstreamStore.open()
  })

  const useEzVault = () => {
    vaultUrl$(EZ_VAULT_URL)
    presentation.migrationPendingEzOpen$(true)
  }

  const modalProps = useStore(() => ({
    ...upstreamStore,
    shouldAlwaysDisplay$: true,
    render: useCallback(function () {
      return this.h`<vault-messenger-wrapper />`
    })
  }))

  return h`
    <style>${cssStrings.defaultTheme}</style>
    ${isLegacy$()
      ? h`<a-modal props=${modalProps} />`
      : h`
          <a-dialog
            props=${{
              open$: upstreamStore.isOpen$,
              heading$: presentation.drawerHeading$,
              description$: presentation.drawerDescription$,
              noCloseOnEscape$: presentation.drawerNoCloseOnEscape$,
              noCloseOnBackdrop$: presentation.drawerNoCloseOnBackdrop$,
              showCloseButton$: presentation.drawerShowCloseButton$,
              drawerPosition$: presentation.drawerPosition$,
              closeLabel$: drawerCloseLabel$,
              themeClass$: presentation.drawerThemeClass$,
              style$: presentation.drawerStyle$,
              onDialogClose: upstreamStore.close.bind(upstreamStore),
              onDialogCancel: upstreamStore.close.bind(upstreamStore),
              children: {
                default: h`
                  <div class="vault-drawer-content">
                    <style>${/* css */`
                      .vault-drawer-content {
                        width: 100%;
                        height: 100%;
                        min-height: 0;
                      }

                      .vault-drawer-content vault-messenger-wrapper,
                      .vault-drawer-content vault-messenger {
                        display: block;
                        width: 100%;
                        height: 100%;
                        min-height: 0;
                      }
                    `}</style>
                    <vault-messenger-wrapper />
                  </div>
                `
              }
            }}
          />
        `}
    <vault-migration-dialog props=${{
      open$: migrationOpen$,
      onUseEzVault: useEzVault
    }} />
  `
})

f('vault-messenger-wrapper', function () {
  const storage = useWebStorage(localStorage)
  const {
    config_vaultUrl$: vaultUrl$
  } = storage

  useTask(() => {
    if (vaultUrl$() !== undefined) return

    vaultUrl$(IS_DEVELOPMENT
      // EZ Vault's local development server.
      // Or 'http://vault.localhost:10000' if using npm run _start
      // but Chrome support was lacking
      ? 'http://localhost:4000'
      // http://vault.localhost asks for usb device instead of for browser extension
      // ? `${location.protocol}//vault.${location.host}`
      : EZ_VAULT_URL)
  })

  const isReachable$ = useSignal(false)

  useTask(async ({ track, cleanup }) => {
    const url = track(() => vaultUrl$())
    if (!url) {
      isReachable$(false)
      return
    }

    isReachable$(false)
    let attempt = 0
    let timeoutId
    const ac = new AbortController()
    cleanup(() => {
      clearTimeout(timeoutId)
      ac.abort()
    })

    const check = async () => {
      try {
        await fetch(url, { mode: 'no-cors', signal: ac.signal })
        if (ac.signal.aborted) return
        isReachable$(true)
      } catch (_err) {
        if (ac.signal.aborted) return
        attempt++
        const delay = Math.min(30000, 500 * (2 ** attempt))
        console.warn(`Vault unreachable, retrying in ${delay}ms`)
        timeoutId = setTimeout(check, delay)
      }
    }
    check()
  }, { after: 'rendering' })

  if (!vaultUrl$() || !isReachable$()) return this.h``

  return this.h`${this.h({ key: vaultUrl$() })`<vault-messenger />`}`
})

f('vault-migration-dialog', ({ h, props }) => {
  const locale$ = useLocaleSignal()
  const vaultModalStore = useVaultModalStore()
  const { askVault } = useVaultActor()
  const { disableStartAtVaultHomeWorkaroundThisTime } = useVaultMessengerStore()
  const s = useStore(() => ({
    isBusy$: false,
    hasError$: false,
    wasOpen: false,
    noCloseOnEscape$: true,
    noCloseOnBackdrop$: true,
    showCloseButton$: false,
    drawerPosition$: '',
    description$: '',
    themeClass$: cssClasses.defaultTheme,
    dialogStyle$: `
      --a-dialog-background: ${cssVars.colors.bg2Lighter};
      --a-dialog-border-color: ${cssVars.colors.mg2};
      --a-dialog-text: ${cssVars.colors.fg2};
      --a-dialog-focus-ring: ${cssVars.colors.bgPrimary};
      --a-dialog-z-index: 1100;
    `,
    async openBackup () {
      if (this.isBusy$()) return
      this.isBusy$(true)
      this.hasError$(false)
      try {
        const response = await askVault(
          { code: 'OPEN_VAULT_BACKUP', payload: null },
          { timeout: 120000, instant: true }
        )
        if (response.error || !response.payload?.isRouteReady) {
          throw response.error || new Error('Backup route was not ready')
        }

        // The legacy route was selected deliberately; don't let opening the
        // modal's Firefox workaround navigate back home over it.
        disableStartAtVaultHomeWorkaroundThisTime()
        vaultModalStore.open()
      } catch (error) {
        console.warn('Failed to open the legacy vault backup', error)
        this.hasError$(true)
      } finally {
        this.isBusy$(false)
      }
    },
    useEzVault () {
      if (this.isBusy$()) return
      this.isBusy$(true)
      this.hasError$(false)
      try {
        props.onUseEzVault()
      } catch (error) {
        console.warn('Failed to select EZ Vault', error)
        this.hasError$(true)
        this.isBusy$(false)
      }
    }
  }))
  const heading$ = useComputed(() => {
    locale$()
    return t('44b-vault is being discontinued')
  })

  useTask(({ track }) => {
    const isOpen = track(() => props.open$())
    if (isOpen && !s.wasOpen) {
      s.isBusy$(false)
      s.hasError$(false)
    }
    s.wasOpen = isOpen
  })

  locale$()
  return h`
    <a-dialog
      props=${{
        open$: props.open$,
        heading$,
        description$: s.description$,
        noCloseOnEscape$: s.noCloseOnEscape$,
        noCloseOnBackdrop$: s.noCloseOnBackdrop$,
        showCloseButton$: s.showCloseButton$,
        drawerPosition$: s.drawerPosition$,
        themeClass$: s.themeClass$,
        style$: s.dialogStyle$,
        children: {
          default: h`
            <div class="vault-migration-card">
              <style>${/* css */`
                .vault-migration-card {
                  width: min(460px, calc(100dvw - 96px));
                  color: ${cssVars.colors.fg2};
                }

                .vault-migration-copy {
                  margin: 0;
                  line-height: 1.5;
                }

                .vault-migration-error {
                  min-height: 1.4em;
                  margin-block-start: 14px;
                  color: ${cssVars.colors.fgError};
                  font-size: 14rem;
                }

                .vault-migration-actions {
                  display: flex;
                  flex-wrap: wrap;
                  justify-content: flex-end;
                  gap: 10px;
                  margin-block-start: 18px;
                }

                .vault-migration-actions button {
                  min-height: 40px;
                  padding: 8px 14px;
                  border: 1px solid ${cssVars.colors.mg2};
                  border-radius: 7px;
                  color: ${cssVars.colors.fg2};
                  background: ${cssVars.colors.bg3};
                  cursor: pointer;
                }

                .vault-migration-actions button[data-primary='true'] {
                  border-color: ${cssVars.colors.bgPrimary};
                  color: ${cssVars.colors.fgAccent};
                  background: ${cssVars.colors.bgPrimary};
                }

                .vault-migration-actions button:disabled {
                  opacity: 0.55;
                  cursor: wait;
                }

                @media (max-width: 520px) {
                  .vault-migration-card {
                    width: min(460px, calc(100dvw - 72px));
                  }

                  .vault-migration-actions {
                    align-items: stretch;
                    flex-direction: column;
                  }
                }
              `}</style>
              <p class="vault-migration-copy">
                ${t('To continue, choose an option below. Back up your keys first if you may need them; keys are not transferred automatically.')}
              </p>
              <div class="vault-migration-error" role="alert">
                ${s.hasError$() ? t('Could not open the backup. Try again.') : ''}
              </div>
              <div class="vault-migration-actions">
                <button
                  type="button"
                  disabled=${s.isBusy$()}
                  onclick=${s.openBackup}
                >
                  ${t('Back up in 44b-vault')}
                </button>
                <button
                  type="button"
                  data-primary="true"
                  disabled=${s.isBusy$()}
                  onclick=${s.useEzVault}
                >
                  ${t('Use EZ Vault')}
                </button>
              </div>
            </div>
          `
        }
      }}
    />
  `
})

function useVaultMessengerStore ({ shouldInit = false } = {}) {
  if (!shouldInit) return useGlobalStore('vaultMessenger')
  return useGlobalStore('vaultMessenger', () => ({
    isWorkarounEnabled$: true,
    disableStartAtVaultHomeWorkaroundThisTime () {
      this.isWorkarounEnabled$(false)
    },
    isFirstRun$: true,
    vaultPort$: null,
    vaultIframeRef$: null,
    vaultIframeSrc$: 'about:blank',
    isVaultMessengerReady$: false,
    widgetHeight$: 0,
    connectedVaultUrl$: null
  }))
}

f('vault-messenger', function () {
  const {
    isFirstRun$,
    vaultPort$,
    vaultIframeRef$,
    vaultIframeSrc$,
    isVaultMessengerReady$,
    widgetHeight$,
    connectedVaultUrl$,
    isWorkarounEnabled$
  } = useVaultMessengerStore()

  // set vaultPort$ to null on unmount so that if user sets a bogus vault url,
  // meaning <vault-messenger> won't fully init,
  // the port won't be stuck to the previous one
  useTask(({ cleanup }) => cleanup(() => {
    vaultPort$(null)
    connectedVaultUrl$(null)
    vaultIframeSrc$('about:blank')
  }))

  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const {
    config_vaultUrl$: vaultUrl$
  } = storage

  const { cancelPreviousRequests, tellVault } = useVaultActor()
  const vaultModalStore = useVaultModalStore()
  const { isOpen$ } = vaultModalStore
  useTask(({ track }) => {
    const isOpen = track(() => isOpen$())
    if (isFirstRun$() || isOpen) return

    if (vaultPort$()) {
      tellVault(
        { code: 'CLOSED_VAULT_VIEW', payload: null },
        { instant: true }
      )
    }
  })

  // Temporary workaround for bugged 'CLOSED_VAULT_VIEW' vault msg handling
  // due to how html dialogs work, atleast on Firefox
  useTask(({ track }) => {
    const wasWorkarounEnabled = isWorkarounEnabled$()
    isWorkarounEnabled$(true)
    const isClosed = track(() => !isOpen$())
    if (isFirstRun$() || isClosed || !wasWorkarounEnabled) return

    if (vaultPort$()) {
      tellVault(
        { code: 'OPEN_VAULT_HOME', payload: null },
        { instant: true }
      )
    }
  })

  useTask(() => { isFirstRun$(false) })

  useTask(async ({ track, cleanup }) => {
    track(() => vaultUrl$())
    const ac = new AbortController()
    cleanup(() => { ac.abort() })

    const vaultOrigin = new URL(vaultUrl$()).origin
    let renderHandshakeController
    const stopRenderHandshake = () => {
      if (!renderHandshakeController) return
      renderHandshakeController.abort()
    }
    const trackRenderHandshakeController = controller => {
      renderHandshakeController = controller
      if (!controller) return
      controller.signal.addEventListener('abort', () => {
        if (renderHandshakeController === controller) renderHandshakeController = null
      }, { once: true })
    }
    vaultIframeRef$().addEventListener('load', () => {
      setTimeout(() => {
        stopRenderHandshake()
        const controller = startRenderHandshake({
          vaultIframe: vaultIframeRef$(),
          vaultPort$,
          abortSignal: ac.signal
        })
        trackRenderHandshakeController(controller)
      }, 100) // give the iframe some time for its js to init
    }, { signal: ac.signal })
    initMessageListener({
      vaultIframe: vaultIframeRef$(),
      vaultOrigin,
      vaultPort$,
      componentSignal: ac.signal,
      widgetHeight$,
      storage,
      tabStorage,
      stopRenderHandshake,
      vaultModalStore,
      connectedVaultUrl$,
      connectedVaultUrl: vaultUrl$()
    })
    isVaultMessengerReady$(true)
  }, { after: 'rendering' })

  useTask(async ({ track }) => {
    const [isReady, vaultUrl] = track(() => [isVaultMessengerReady$(), vaultUrl$()])
    if (!isReady) return

    vaultIframeSrc$(vaultUrl)
    cancelPreviousRequests(new Error('Canceled due to new vault URL selection'))
  })

  return this.h`
    <style>
      #vault {
        border: none;
        width: 100%;
        height: 100%;
        display: block; /* ensure it's not inline */
      }
    </style>
    <iframe
      allow='clipboard-write;
             publickey-credentials-create;
             publickey-credentials-get'
      style=${{
        height: isLegacyVaultUrl(vaultUrl$())
          ? `${widgetHeight$()}px`
          : '100%'
      }}
      id='vault'
      title='Vault'
      ref=${vaultIframeRef$}
      src=${vaultIframeSrc$()}
    />
  `
})

// Module-level reference to the active vault port, kept in sync by initMessageListener.
// Allows non-hook code (e.g. async tracking functions) to fire-and-forget messages to the vault.
let _activeVaultPort = null
const _pendingVaultMessages = []
const MAX_PENDING_VAULT_MESSAGES = 50

export function tellVault (msg) {
  if (!_activeVaultPort) {
    if (_pendingVaultMessages.length < MAX_PENDING_VAULT_MESSAGES) {
      _pendingVaultMessages.push(msg)
    }
    return
  }
  tell(_activeVaultPort, msg)
}

export function flushQueuedVaultAcceptedMessages ({ vaultPort = _activeVaultPort } = {}) {
  if (!vaultPort) return Promise.resolve(false)
  return flushVaultAcceptedMessageQueue({ vaultPort, ask })
}

function initMessageListener ({
  vaultIframe,
  vaultOrigin,
  vaultPort$,
  componentSignal,
  widgetHeight$,
  storage,
  tabStorage,
  stopRenderHandshake,
  vaultModalStore,
  connectedVaultUrl$,
  connectedVaultUrl
}) {
  let currentVaultPort = null
  const vaultNostrDbSubscriptions = new Map()
  const unsubscribeLocale = subscribeLocaleChanged(() => {
    if (currentVaultPort) translateVault(currentVaultPort)
  })
  // Setup cleanup
  componentSignal?.addEventListener('abort', () => {
    unsubscribeLocale()
    if (currentVaultPort) {
      currentVaultPort.close()
      currentVaultPort = null
      _activeVaultPort = null
      connectedVaultUrl$(null)
      _pendingVaultMessages.length = 0
      closeTrustedVaultNostrDbSubscriptions(vaultNostrDbSubscriptions)
    }
  }, { once: true })

  let ac
  window.addEventListener('message', async e => {
    if (
      e.data.code !== 'VAULT_READY' ||
      e.source !== vaultIframe.contentWindow ||
      e.origin !== vaultOrigin ||
      !e.ports[0]
    ) return

    if (!e.data.payload.accounts) console.log('Missing account data on vault startup')
    else await applyVaultAccountsState(e.data.payload.accounts)

    // vault iframe's page may reload on sw controller change (and send a new 'VAULT_READY' msg)
    ac?.abort()
    ac = new AbortController()
    closeTrustedVaultNostrDbSubscriptions(vaultNostrDbSubscriptions)
    if (currentVaultPort) currentVaultPort.close()
    currentVaultPort = e.ports[0]
    _activeVaultPort = currentVaultPort
    listenToVaultMessages({ vaultPort: currentVaultPort, signal: AbortSignal.any([componentSignal, ac.signal]) })
    // before setting vaultPort$, which could trigger other messages to vault
    stopRenderHandshake?.()
    // BROWSER_READY must be the first message the vault receives
    tellVaultImReady(currentVaultPort)
    // Make it work with ez-vault's simplified messenger
    if (e.data.reqId) reply(e, { payload: true })
    translateVault(currentVaultPort)
    _pendingVaultMessages.splice(0).forEach(msg => tell(_activeVaultPort, msg))
    flushQueuedVaultAcceptedMessages({ vaultPort: currentVaultPort })
      .catch(err => console.warn('Failed to flush queued vault messages', err))
    connectedVaultUrl$(connectedVaultUrl)
    vaultPort$(currentVaultPort)
  }, { signal: componentSignal })

  async function applyVaultAccountsState (accounts) {
    try {
      await pruneNostrDbsForVaultAccounts(accounts)
    } catch (err) {
      console.warn('Failed to prune stale NostrDB databases', err)
    }
    setAccountsState(accounts, storage, tabStorage)
  }

  function listenToVaultMessages ({ vaultPort, signal }) {
    vaultPort.addEventListener('message', async e => {
      switch (e.data.code) {
        case 'CHANGE_DIMENSIONS': {
          widgetHeight$(e.data.payload.height)
          break
        }
        case 'CLOSE_VAULT_VIEW': {
          vaultModalStore.close()
          break
        }
        case 'SET_ACCOUNTS_STATE': {
          if (!e.data.payload.accounts) {
            console.log('Missing account data on vault message')
            break
          }
          await applyVaultAccountsState(e.data.payload.accounts)
          break
        }
        case 'NOSTRDB': {
          const { ownerPubkey, method, params = [], subscriptionId } = e.data.payload || {}
          if (method === 'subscribe') {
            streamTrustedVaultNostrDbSubscription(e, {
              vaultPort,
              ownerPubkey,
              params,
              subscriptionId,
              subscriptions: vaultNostrDbSubscriptions,
              getVaultPort: () => _activeVaultPort
            })
            break
          }
          try {
            reply(e, {
              payload: await runTrustedVaultNostrDbMethod({
                vaultPort,
                ownerPubkey,
                method,
                params,
                getVaultPort: () => _activeVaultPort,
                isAppInstalled: ({ ownerPubkey, appId }) => isNostrDbAppInstalledForOwner({
                  storage,
                  ownerPubkey,
                  appId
                })
              })
            }, { to: vaultPort })
          } catch (error) {
            reply(e, { error }, { to: vaultPort })
          }
          break
        }
        case 'NOSTRDB_CANCEL': {
          cancelTrustedVaultNostrDbSubscription(vaultNostrDbSubscriptions, e.data.payload?.subscriptionId)
          break
        }
      }
    }, { signal })
    vaultPort.start()
  }

  function tellVaultImReady (vaultPort) {
    const readyMsg = {
      code: 'BROWSER_READY',
      payload: null
    }
    tell(vaultPort, readyMsg)
  }

  function translateVault (vaultPort) {
    const locale = getEffectiveLocale()
    ask(vaultPort, {
      code: 'TRANSLATE',
      payload: {
        locale,
        lang: locale === 'pt-BR' ? 'pt' : 'en'
      }
    }, { timeout: 5000 }).then(({ error }) => {
      if (error) console.warn('Failed to update vault locale', error)
    })
  }
}

function startRenderHandshake ({
  vaultIframe,
  vaultPort$,
  abortSignal
}) {
  if (abortSignal?.aborted) return null
  const controller = new AbortController()
  const { signal } = controller
  let retryId
  const stop = () => {
    if (controller.signal.aborted) return
    controller.abort()
  }
  if (abortSignal) abortSignal.addEventListener('abort', stop, { once: true })
  signal.addEventListener('abort', () => {
    if (retryId) clearTimeout(retryId)
  }, { once: true })

  const MAX_ATTEMPTS = 40
  let attempts = 0
  const sendRender = () => {
    if (signal.aborted) return
    const targetWindow = vaultIframe?.contentWindow
    if (!targetWindow) {
      stop()
      return
    }
    tell(
      targetWindow,
      { code: 'RENDER', payload: null },
      // don't set to vaultOrigin here, as it may not be ready yet
      { targetOrigin: '*' }
    )
    if (vaultPort$()) {
      stop()
      return
    }
    if (attempts >= MAX_ATTEMPTS) {
      stop()
      return
    }
    attempts += 1
    const delay = Math.min(500, 50 * attempts)
    retryId = setTimeout(sendRender, delay)
  }

  sendRender()
  return controller
}

export function useVaultActor (vaultPort$) {
  if (vaultPort$ !== undefined) useVaultActorInit(vaultPort$)
  return useGlobalStore('vaultActor')
}

function useVaultActorInit (vaultPort$) {
  const storage = useWebStorage(localStorage)
  const {
    config_vaultUrl$: vaultUrl$
  } = storage

  const {
    msgQueue$
  } = useGlobalStore('vaultActor', () => ({
    vaultPort$,
    vaultOrigin$ () { return new URL(vaultUrl$()).origin },
    msgQueue$: {
      waiting: [],
      running: []
    },
    tellVault (msg) {
      if (!this.vaultPort$()) return Promise.reject(new Error('Vault not connected'))
      tell(this.vaultPort$(), msg)
    },
    async askVault (msg, { timeout, instant = false } = {}) {
      if (instant) {
        if (!this.vaultPort$()) return Promise.reject(new Error('Vault not connected'))
        return ask(this.vaultPort$(), msg, {
          ...(timeout != null && { timeout })
        })
      }

      const queuedAt = Date.now()
      const p = Promise.withResolvers()
      p.promise.finally(() => {
        // trigger useTask below
        this.msgQueue$(v => {
          v.running = v.running.filter(r => r.p !== p)
          return { ...v }
        })
      })

      // trigger useTask below
      this.msgQueue$(v => {
        v.waiting.push({ msg, timeout, queuedAt, p })
        return { ...v }
      })
      return p.promise
    },
    cancelPreviousRequests (error) {
      this.msgQueue$().running.forEach(v => v.p.resolve({
        // same signature as ask()'s soft-rejection
        code: v.msg.code,
        payload: null,
        error: error || new Error('Canceled')
      }))
    }
  }))

  const vaultModalStore = useVaultModalStore()
  const {
    session_openWorkspaceKeys$: openWorkspaceKeys$
  } = storage
  const userPk$ = useComputed(() => {
    const wsKey = openWorkspaceKeys$()[0]
    return storage[`session_workspaceByKey_${wsKey}_userPk$`]()
  })
  const isLoggedIn$ = useComputed(() => userPk$() !== storage.session_defaultUserPk$() || openWorkspaceKeys$().length > 1)
  const maybeFailEarly = useCallback(job => {
    if (isLoggedIn$()) return false

    // TODO: don't trigger it if automated requests such as the signing of AUTH events
    vaultModalStore.open()
    job.p.resolve({
      code: job.msg.code,
      payload: null,
      error: new Error('Not logged in')
    })
    return true
  })

  // synchronous; no need to guard againt multiple calls
  useTask(({ track }) => {
    const [queue, vaultPort] = track(() => [msgQueue$(), vaultPort$()])
    if (!vaultPort) return

    const promisesToStart = Math.min(5 - queue.running.length, queue.waiting.length)
    const now = Date.now()
    for (let i = 0; i < promisesToStart; i++) {
      const job = queue.waiting.shift()
      queue.running.push(job)
      if (maybeFailEarly(job)) return

      const { msg, timeout, queuedAt, p } = queue.running[queue.running.length - promisesToStart + i]
      // this never errors out, it resolves with { error } in that case
      ask(vaultPort, msg, {
        ...(timeout != null && { timeout: queuedAt + timeout - now })
      })
        .then(v => { p.resolve(v) })
    }
  })
}
