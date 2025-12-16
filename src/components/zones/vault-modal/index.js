import { f, useGlobalStore, useClosestStore, useStore, useTask, useCallback, useComputed, useSignal } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import { postMessage, requestMessage } from '#helpers/window-message/index.js'
import { setAccountsState } from '#zones/screen/use-init-or-reset-screen.js'
import '#shared/modal.js'

export function useVaultModalStore (init) {
  if (init) return useVaultModalInit(init)
  return useClosestStore('<a-modal>')
}

function useVaultModalInit (init) {
  return useClosestStore('<a-modal>', init)
}

f('vaultModal', function () {
  // other components may open/close it
  const upstreamStore = useVaultModalStore()
  const modalProps = useStore(() => ({
    ...upstreamStore,
    shouldAlwaysDisplay$: true,
    render: useCallback(function () {
      return this.h`<vault-messenger-wrapper />`
    })
  }))
  return this.h`<a-modal props=${modalProps} />`
})

f('vault-messenger-wrapper', function () {
  const storage = useWebStorage(localStorage)
  const {
    config_vaultUrl$: vaultUrl$
  } = storage

  useTask(() => {
    if (vaultUrl$() !== undefined) return

    vaultUrl$(IS_DEVELOPMENT
      // Or 'http://vault.localhost:10000' if using npm run _start
      // but Chrome support was lacking
      ? 'http://localhost:4000'
      // http://vault.localhost asks for usb device instead of for browser extension
      // ? `${location.protocol}//vault.${location.host}`
      : 'https://44billion.github.io/44b-vault')
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

  const { vaultPort$ } = useVaultMessengerStore({ shouldInit: true })
  // init it even if vault isn't ready yet cause other components may try to use its methods
  useRequestVaultMessage(vaultPort$)

  if (!vaultUrl$() || !isReachable$()) return this.h``

  return this.h`${this.h({ key: vaultUrl$() })`<vault-messenger />`}`
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
    widgetHeight$: 0
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
    isWorkarounEnabled$
  } = useVaultMessengerStore()

  // set vaultPort$ to null on unmount so that if user sets a bogus vault url,
  // meaning <vault-messenger> won't fully init,
  // the port won't be stuck to the previous one
  useTask(({ cleanup }) => cleanup(() => {
    vaultPort$(null)
    vaultIframeSrc$('about:blank')
  }))

  const storage = useWebStorage(localStorage)
  const {
    config_vaultUrl$: vaultUrl$
  } = storage

  const { cancelPreviousRequests, postVaultMessage } = useRequestVaultMessage(vaultPort$)
  const vaultModalStore = useVaultModalStore()
  const { isOpen$ } = vaultModalStore
  useTask(({ track }) => {
    const isOpen = track(() => isOpen$())
    if (isFirstRun$() || isOpen) return

    if (vaultPort$()) {
      postVaultMessage(
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
      postVaultMessage(
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
      stopRenderHandshake,
      vaultModalStore
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
      style=${{ height: `${widgetHeight$()}px` }}
      id='vault'
      ref=${vaultIframeRef$}
      src=${vaultIframeSrc$()}
    />
  `
})

function initMessageListener ({
  vaultIframe,
  vaultOrigin,
  vaultPort$,
  componentSignal,
  widgetHeight$,
  storage,
  stopRenderHandshake,
  vaultModalStore
}) {
  let currentVaultPort = null
  // Setup cleanup
  componentSignal?.addEventListener('abort', () => {
    if (currentVaultPort) {
      currentVaultPort.close()
      currentVaultPort = null
    }
  }, { once: true })

  let ac
  window.addEventListener('message', e => {
    if (
      e.data.code !== 'VAULT_READY' ||
      e.source !== vaultIframe.contentWindow ||
      e.origin !== vaultOrigin ||
      !e.ports[0]
    ) return

    if (!e.data.payload.accounts) console.log('Missing account data on vault startup')
    else setAccountsState(e.data.payload.accounts, storage)

    // vault iframe's page may reload on sw controller change (and send a new 'VAULT_READY' msg)
    ac?.abort()
    ac = new AbortController()
    if (currentVaultPort) currentVaultPort.close()
    currentVaultPort = e.ports[0]
    listenToVaultMessages({ vaultPort: currentVaultPort, signal: AbortSignal.any([componentSignal, ac.signal]) })
    // before setting vaultPort$, which could trigger other messages to vault
    stopRenderHandshake?.()
    tellVaultImReady(currentVaultPort)
    vaultPort$(currentVaultPort)
  }, { signal: componentSignal })

  function listenToVaultMessages ({ vaultPort, signal }) {
    vaultPort.addEventListener('message', e => {
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
          setAccountsState(e.data.payload.accounts, storage)
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
    postMessage(vaultPort, readyMsg)
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
    postMessage(
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

export function useRequestVaultMessage (vaultPort$) {
  if (vaultPort$ !== undefined) useRequestVaultMessageInit(vaultPort$)
  return useGlobalStore('useRequestVaultMessage')
}

function useRequestVaultMessageInit (vaultPort$) {
  const storage = useWebStorage(localStorage)
  const {
    config_vaultUrl$: vaultUrl$
  } = storage

  const {
    msgQueue$
  } = useGlobalStore('useRequestVaultMessage', () => ({
    vaultPort$,
    vaultOrigin$ () { return new URL(vaultUrl$()).origin },
    msgQueue$: {
      waiting: [],
      running: []
    },
    postVaultMessage (msg) {
      if (!this.vaultPort$()) return Promise.reject(new Error('Vault not connected'))
      postMessage(this.vaultPort$(), msg)
    },
    async requestVaultMessage (msg, { timeout, instant = false } = {}) {
      if (instant) {
        if (!this.vaultPort$()) return Promise.reject(new Error('Vault not connected'))
        return requestMessage(this.vaultPort$(), msg, {
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
        // same signature as requestMessage's soft-rejection
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
      requestMessage(vaultPort, msg, {
        ...(timeout != null && { timeout: queuedAt + timeout - now })
      })
        .then(v => { p.resolve(v) })
    }
  })
}
