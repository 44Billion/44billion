import { f, useGlobalStore, useClosestStore, useStore, useTask, useCallback, useComputed } from '#f'
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

f(function vaultModal () {
  // other components may open/close it
  const upstreamStore = useVaultModalStore()
  const modalProps = useStore(() => ({
    ...upstreamStore,
    shouldAlwaysDisplay$: true,
    render: useCallback(function () {
      return this.h`<vault-messenger />`
    })
  }))
  return this.h`<a-modal props=${modalProps} />`
})

f(function vaultMessenger () {
  const {
    vaultPort$,
    vaultIframeRef$,
    vaultIframeSrc$,
    isVaultMessengerReady$,
    widgetMinHeight$
  } = useGlobalStore('vaultMessenger', () => ({
    vaultPort$: null,
    vaultIframeRef$: null,
    vaultIframeSrc$: 'about:blank',
    isVaultMessengerReady$: false,
    widgetMinHeight$: 0
  }))
  const storage = useWebStorage(localStorage)
  const {
    config_vaultUrl$: vaultUrl$
  } = storage

  useTask(() => {
    if (vaultUrl$() !== undefined) return

    vaultUrl$(IS_DEVELOPMENT
      ? 'http://localhost:4000/docs/' // vscode preview
      // http://vault.localhost asks for usb device instead of for browser extension
      // ? `${location.protocol}//vault.${location.host}`
      : 'https://44billion.github.io/44b-vault')
  })

  const { cancelPreviousRequests } = useRequestVaultMessage(vaultPort$)

  useTask(async ({ track, cleanup }) => {
    track(() => vaultUrl$())
    const ac = new AbortController()
    cleanup(() => ac.abort())
    initMessageListener({
      vaultIframe: vaultIframeRef$(),
      vaultOrigin: new URL(vaultUrl$()).origin,
      vaultPort$,
      componentSignal: ac.signal,
      widgetMinHeight$,
      storage
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
      style=${{ minHeight: `${widgetMinHeight$()}px` }}
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
  widgetMinHeight$,
  storage
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
    tellVaultImReady(currentVaultPort)
    vaultPort$(currentVaultPort)
  }, { signal: componentSignal })

  function listenToVaultMessages ({ vaultPort, signal }) {
    vaultPort.addEventListener('message', e => {
      switch (e.data.code) {
        // TODO: maybe 'CLOSE_VAULT_VIEW' after adding account
        case 'CHANGE_DIMENSIONS': {
          widgetMinHeight$(e.data.payload.height)
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

export function useRequestVaultMessage (vaultPort$) {
  if (vaultPort$) useRequestVaultMessageInit(vaultPort$)
  return useGlobalStore('useRequestVaultMessage')
}

function useRequestVaultMessageInit (vaultPort$) {
  const storage = useWebStorage(localStorage)
  const {
    config_vaultUrl$: vaultUrl$
  } = storage

  const {
    vaultOrigin$,
    msgQueue$
  } = useGlobalStore('useRequestVaultMessage', () => ({
    vaultPort$,
    vaultOrigin$ () { return new URL(vaultUrl$()).origin },
    msgQueue$: {
      waiting: [],
      running: []
    },
    async requestVaultMessage (msg, { timeout } = {}) {
      const queuedAt = Date.now()
      const p = Promise.withResolvers()
      p.promise.finally(() => {
        // trigger useTask below
        this.msgQueue$((v, eqKey) => {
          v.running = v.running.filter(r => r.p !== p)
          v[eqKey] = Math.random()
          return v
        })
      })

      // trigger useTask below
      this.msgQueue$((v, eqKey) => {
        v.waiting.push({ msg, timeout, queuedAt, p })
        v[eqKey] = Math.random()
        return v
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
  const isLoggedIn$ = useComputed(() => !!userPk$() || openWorkspaceKeys$().length > 1)
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
        targetOrigin: vaultOrigin$(),
        ...(timeout != null && { timeout: queuedAt + timeout - now })
      })
        .then(v => { p.resolve(v) })
    }
  })
}
