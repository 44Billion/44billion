import { f, useCallback, useComputed, useStore, useGlobalSignal, useStateSignal, useSignal, useClosestSignal, useClosestStore, useTask } from '#f'
import AppFileManager from '#services/app-file-manager/index.js'
import useInitOrResetScreen from './use-init-or-reset-screen.js'
import useCollectScreenGarbage from './use-collect-screen-garbage.js'
import useWebStorage from '#hooks/use-web-storage.js'
import useLongPress from '#hooks/use-long-press.js'
import useScrollbarConfig from '#hooks/use-scrollbar-config.js'
import '#shared/menu.js'
import '#shared/avatar.js'
import {
  cssStrings,
  cssClasses,
  cssVars
} from '#assets/styles/theme.js'
import useAppRouter from './use-app-router.js'
import { initMessageListener } from '#helpers/window-message/browser/index.js'
import { base62ToBase36 } from '#helpers/base36.js'
import { appIdToAppSubdomain } from '#helpers/app.js'
import { useVaultModalStore, useRequestVaultMessage } from '#zones/vault-modal/index.js'
import '#shared/napp-assets-caching-progress-bar.js'
import '#shared/svg.js'
import '#shared/icons/icon-close.js'
import '#shared/icons/icon-minimize.js'
import '#shared/icons/icon-maximize.js'
import '#shared/icons/icon-stack-front.js'
import '#shared/icons/icon-remove.js'
import '#shared/icons/icon-delete.js'

f(function aScreen () {
  useInitOrResetScreen()
  useCollectScreenGarbage()
  useAppRouter()

  const isSingleWindow$ = useWebStorage(localStorage).config_isSingleWindow$
  const style$ = useComputed(() => /* css */`
    /* @scope { */
    #screen {
      &${cssStrings.defaultTheme}

      & {
        display: flex;
        width: 100dvw;
        height: 100dvh;

        @media (orientation: landscape) {
          flex-direction: row; /* -reverse; */
        }
        @media (orientation: portrait) {
          flex-direction: column;
        }
        /**/
      }
    }

    #workspaces {
      flex: 1;
      position: relative;

      /* system views; above all; widgets view would be similar but below it with z-i:1 while sysviews z-i:2 */
      #system-views {
        display: block !important; /* NO pois vai ficar sobre todos n vai poder selecionar txt etc*/
        display: none !important; /* TODO block somente qdo rota de system der match */
        position: absolute;
        inset: 0;
        z-index: 1;
        overflow: hidden;
      }

      #windows {
        display: flex !important;
        @media (orientation: portrait) {
          flex-direction: column;
        }
        position: absolute;
        inset: 0;
        z-index: 0;
        overflow: hidden;
      }
    }

    #unified-toolbar {
      display: flex !important;
      @media (orientation: portrait) {
        min-height: 50px;
      }
      @media (orientation: landscape) {
        flex-direction: column;
        min-width: 50px;
      }
      flex: 0 0 auto;
      background-color: ${cssVars.colors.mg};
      /**/
    }
  `)

  const unifiedToolbarRef$ = useClosestSignal('unifiedToolbarRef', null)

  return this.h`
    <div id="screen" class=${{
      'multi-window': !isSingleWindow$(),
      [cssClasses.defaultTheme]: true
    }}>
      <style>${style$()}</style>
      <div id='workspaces'>
        <a-windows id='windows' />
        <system-views id='system-views' />
      </div>
      <unified-toolbar ref=${unifiedToolbarRef$} id='unified-toolbar' />
    </div>
  `
})

f(function systemViews () {
  return this.h`
    <div
      style=${`
        background-color: ${cssVars.colors.bg};
        display: none; /* while not at route */
      `}
    >
      system views
    </div>
  `
})

f(function aWindows () {
  const {
    // order is important, that's why we didn't compute from workspaceKeys$
    // recently opened/clicked first
    session_openWorkspaceKeys$: openWorkspaceKeys$
  } = useWebStorage(localStorage)

  return this.h`
    ${openWorkspaceKeys$().map(workspaceKey =>
      this.h({ key: workspaceKey })`<workspace-window key=${workspaceKey} props=${{ workspaceKey }} />`
    )}
    <windows-background />
  `
})
f(function windowsBackground () {
  return this.h`
    <div
      style=${`
        background-color: ${cssVars.colors.bg};
        z-index: 0;
        inset: 0;
        position: absolute;
      `}
    >please open an app</div>
  `
})
f(function workspaceWindow () {
  // App instances are useful for grouping app icons, but windows are not grouped by app
  // That's why we have openAppKeys$ instead of openAppIds$
  const {
    [`session_workspaceByKey_${this.props.workspaceKey}_openAppKeys$`]: openAppKeys$
  } = useWebStorage(localStorage)
  const mruRankByAppKey = useComputed(() => openAppKeys$().cssOrder.reduce((r, v, i) => ({ ...r, [v]: i + 1 }), {}))()
  return this.h`
    ${openAppKeys$().domOrder.map(appKey => {
      const mruRank = mruRankByAppKey[appKey]
      return this.h({ key: appKey })`
      <app-window key=${appKey} props=${{ appKey, wsKey: this.props.workspaceKey, mruRank }} />
      `
    })}
  `
})
f(function appWindow () {
  const storage = useWebStorage(localStorage)
  const {
    [`session_appByKey_${this.props.appKey}_id$`]: appId$,
    [`session_appByKey_${this.props.appKey}_visibility$`]: appVisibility$,
    [`session_appByKey_${this.props.appKey}_route$`]: initialRoute$,
    [`session_workspaceByKey_${this.props.wsKey}_userPk$`]: maybeUserPk$,
    session_anonPk$: anonPk$
  } = storage
  const userPkB36$ = useComputed(() => base62ToBase36(maybeUserPk$() || anonPk$(), 50))
  const appSubdomain$ = useComputed(() => appIdToAppSubdomain(appId$(), userPkB36$()))
  const isClosed$ = useComputed(() => appVisibility$() === 'closed')
  const appIframeRef$ = useSignal()
  const appIframeSrc$ = useSignal('about:blank')
  const { cachingProgress$ } = useClosestStore('<napp-assets-caching-progress-bar>', {
    cachingProgress$: {
      // [filename]: {
      //   progress: 0, // 0-100
      //   // Note: don't use it when it's 0
      //   totalByteSizeEstimate: 0 // 51000 * (total number of chunks - 1); don't count last chunk as it may be smaller)
      // }
    }
  })
  const { requestVaultMessage } = useRequestVaultMessage()

  useTask(
    async ({ track, cleanup }) => {
      const isClosed = track(() => isClosed$())
      // This component won't load when app starts closed
      // because openAppKeys$.domOrder initially is populated
      // by open (or minimized) apps
      // but will be reused on re-opening: open->closed->open
      if (isClosed) {
        cachingProgress$({}) // reset
        return
      }

      const initialRoute = initialRoute$() || ''
      if (initialRoute) initialRoute$('') // reset
      const ac = new AbortController()
      cleanup(() => ac.abort())
      await initMessageListener(
        userPkB36$(), appId$(), appSubdomain$(), initialRoute, appIframeRef$(), cachingProgress$, requestVaultMessage,
        { signal: ac.signal, isSingleNapp: false }
      )
      appIframeSrc$(`//${appSubdomain$()}.${window.location.host}/~~napp`)
    },
    { after: 'rendering' }
  )

  return this.h`
    <div
      style=${`
        background-color: ${cssVars.colors.bg};
      `}
      class=${{
        open: appVisibility$() === 'open',
        scope_khjha3: true,
        [`mru-rank-${this.props.mruRank ?? 'none'}`]: !!this.props.mruRank
      }}
    >
    <style>
      .scope_khjha3 {
        & {
          display: none; /* minimized or closed */
          z-index: 1;
          flex: 0 1 100%;

          @media (orientation: portrait) {
            width: 100%;
          }
          @media (orientation: landscape) {
            height: 100%;
          }
          /**/
          iframe {
            &.tilde-tilde-napp-page { display: none; }

            &.napp-page {
              border: none;
              width: 100%;
              height: 100%;
              display: block; /* ensure it's not inline */
            }
          }
        }
        &.mru-rank-0 { order: 0; }
        &.mru-rank-1 { order: 1; }
        &.mru-rank-2 { order: 2; }
        &.mru-rank-1.open {
          display: block;
        }
        #screen.multi-window &.open {
          &.mru-rank-2 {
            display: block;
          }
          /* thin or thinner (shrinking number) */
          @media (max-aspect-ratio: 8/16) {
            &.mru-rank-3 {
              display: block;
            }
          }
          /* short or shorter (growing number) */
          @media (min-aspect-ratio: 16/8) {
            &.mru-rank-3 {
              display: block;
            }
          }
        }
      }
    </style>
    <napp-assets-caching-progress-bar />
    <iframe
      class="tilde-tilde-napp-page"
      ref=${appIframeRef$}
      src=${appIframeSrc$()}
    />
    </div>
  `
})

// multi-window or not, we use a single toolbar
// if multi-window we update its content with the
// last selected workspace (a user may have many workspaces)
f(function unifiedToolbar () {
  const scrollbar$ = useScrollbarConfig()

  return this.h`
    <style>${`
      /* @scope { */
      #unified-toolbar {
        toolbar-active-avatar {
          flex: 0 0 auto;
          display: flex !important;

          @media (orientation: portrait) {
            min-width: 80px;
          }
          @media (orientation: landscape) {
            flex-direction: column;
            min-height: 80px;
            /**/
          }

          align-items: center;
        }

        toolbar-app-list {
          flex: 1;
          display: flex !important;
          align-items: center;
          overflow: auto hidden;
          gap: 7px;
          padding: 0 7px;

          @media (orientation: landscape) {
            flex-direction: column;
            overflow: hidden auto;
            padding: 7px 0;
          }

          ${scrollbar$.get(false).hasOverlay
            ? ''
            : /* css */`
            scrollbar-color: rgba(255 255 255 / 0.2) transparent; /* thumb track */
            transition: scrollbar-color .3s;
            &:hover {
              scrollbar-color: rgba(255 255 255 / 0.5) transparent;
            }

            scrollbar-width: thin;
            @media (orientation: landscape) {
              /*
                scrollbar-gutter on chrome works just for vertical scrollbars due to a bug
                Considering we can't reliably set styles for specific browsers, we are going
                to restrict it to landscape for everyone
              */
              scrollbar-gutter: stable;
              scrollbar-width: unset; /* or else left prop won't work correctly */
              toolbar-app-launcher > div {
                position: relative;
                left: ${Math.floor(scrollbar$.get(false).width / 2)}px;
              }
            }
          `}
        }
        /**/
      }
    `}</style>
    <toolbar-active-avatar />
    <toolbar-app-list />
  `
})

f(function toolbarActiveAvatar () {
  useClosestStore('<a-menu>', {
    isOpen$: false,
    anchorRef$: null,
    open () { this.isOpen$(true) },
    close () { this.isOpen$(false) },
    toggle () { this.isOpen$(v => !v) }
  })

  return this.h`
    <toolbar-menu />
    <toolbar-avatar />
  `
})
f(function toolbarMenu () {
  // const {
  //   session_workspaceKeys$: workspaceKeys$
  // } = useWebStorage(localStorage)

  const menuStore = useClosestStore('<a-menu>')
  const menuProps = useStore({
    render: useCallback(function () {
      return this.h`<div>User Menu</div>`
      // return this.h`<div>
      //   ${workspaceKeys$().map(workspaceKey =>
      //     this.h({ key: workspaceKey })`<user-option key=${workspaceKey} props=${{ workspaceKey }} />`
      //   )}
      // </div>`
    }),
    style$: () => {
      const modernCSS = `& {
        position-anchor: --toolbar-avatar-menu;
        position-area: top span-right;
        @media (orientation: landscape) {
          position-area: left span-bottom;
        }
      }`
      const fallbackCSS = `& {
        position: fixed;
        z-index: 1000;
      }`
      return CSS.supports('position-anchor', '--test') ? modernCSS : fallbackCSS
    },
    ...menuStore
  })

  return this.h`<a-menu props=${menuProps} />`
})
f(function toolbarAvatar () {
  const storage = useWebStorage(localStorage)
  const { session_openWorkspaceKeys$: openWorkspaceKeys$ } = storage

  const userPk$ = useComputed(() => {
    const wsKey = openWorkspaceKeys$()[0]
    return storage[`session_workspaceByKey_${wsKey}_userPk$`]()
  })
  const { toggle: toggleMenu, close: closeMenu, anchorRef$ } = useClosestStore('<a-menu>')
  const vaultModalStore = useVaultModalStore()
  const isLoggedIn$ = useComputed(() => !!userPk$() || openWorkspaceKeys$().length > 1)
  useTask(({ track }) => {
    if (track(() => isLoggedIn$())) return
    closeMenu()
  })
  const onClick = useCallback(() => {
    if (isLoggedIn$()) return toggleMenu()

    vaultModalStore.open()
  })

  return this.h`<div
    ref=${anchorRef$}
    onclick=${onClick}
    style=${`
      anchor-name: --toolbar-avatar-menu;
      color: ${cssVars.colors.mgFont};
      width: 40px; height: 40px; display: flex; justify-content: center; align-items: center;
      border-radius: 50%;
      position: relative;
    `}
  >
    <a-avatar props=${{ pk$: userPk$(), size: '32px', weight$: 'duotone', strokeWidth$: 1 }} />
  </div>`
})

f(function toolbarAppList () {
  useClosestStore('<a-menu>', () => ({
    isOpenedByLongPress: true,
    isOpen$: false,
    open () { this.isOpen$(true) },
    close () { this.isOpen$(false) },
    app$: { key: '' },
    toggleMenu (nextApp) {
      const isSameApp = this.app$().key === nextApp.key
      if (isSameApp) {
        this.app$(nextApp)
        this.isOpen$(v => !v)
      } else {
        this.close()
        window.requestIdleCallback(() => {
          this.app$(nextApp)
          this.open()
        })
      }
    }
  }), { isStatic: false })

  return this.h`
    <toolbar-pinned-apps />
    <toolbar-unpinned-apps />
  `
})
f(function toolbarPinnedApps () {
  const storage = useWebStorage(localStorage)
  const { session_openWorkspaceKeys$: openWorkspaceKeys$ } = storage
  const appIdsdKeysIndexes$ = useComputed(() => {
    const wsKey = openWorkspaceKeys$()[0]
    const pinnedAppIds = storage[`session_workspaceByKey_${wsKey}_pinnedAppIds$`]() || []
    return pinnedAppIds.reduce((r, appId, i) => {
      const appIndex = i + 1
      storage[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]().forEach(appKey => { r.push({ appId, appKey, appIndex }) })
      return r
    }, [])
  })

  return this.h`${appIdsdKeysIndexes$().map(v => this.h({ key: v.appKey })`<toolbar-app-launcher key=${v.appKey} props=${v} />`)}`
})
f(function toolbarUnpinnedApps () {
  const storage = useWebStorage(localStorage)
  const { session_openWorkspaceKeys$: openWorkspaceKeys$ } = storage
  const appIdsdKeysIndexes$ = useComputed(() => {
    const wsKey = openWorkspaceKeys$()[0]
    const pinnedAppIdsLength = (storage[`session_workspaceByKey_${wsKey}_pinnedAppIds$`]() || []).length
    const unpinnedAppIds = storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`]() || []
    return unpinnedAppIds.reduce((r, appId, i) => {
      const appIndex = i + 1 + pinnedAppIdsLength
      storage[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]().forEach(appKey => { r.push({ appId, appKey, appIndex }) })
      return r
    }, [])
  })

  return this.h`
    <app-launchers-menu />
    ${appIdsdKeysIndexes$().map(v => this.h({ key: v.appKey })`<toolbar-app-launcher key=${v.appKey} props=${v} />`)}
  `
})
f(function appLaunchersMenu () {
  const store = useClosestStore('<a-menu>')
  const storage = useWebStorage(localStorage)
  const menuProps = useStore(() => ({
    ...store,
    openApp () {
      const { visibility, key: appKey, workspaceKey } = this.app$()
      if (visibility === 'open') throw new Error('App is already open')

      this.close() // close menu
      storage[`session_appByKey_${appKey}_visibility$`]('open')
      storage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]((v, eqKey) => {
        // if closed it may not be on domOrder anymore
        if (!v.domOrder.includes(appKey)) v.domOrder.push(appKey)
        const i = v.cssOrder.indexOf(appKey)
        if (i !== -1) v.cssOrder.splice(i, 1) // remove
        v.cssOrder.unshift(appKey) // place at beginning
        v[eqKey] = Math.random()
        return v
      })
    },
    bringToFirst () {
      const { visibility, key: appKey, workspaceKey } = this.app$()
      const { cssOrder } = storage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]()
      if (visibility !== 'open') throw new Error('Can only bring to first when app is open')
      if (cssOrder[0] === appKey) throw new Error('App is already first')

      this.close() // close menu
      let i
      storage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]((v, eqKey) => {
        i = v.cssOrder.indexOf(appKey)
        console.log('position', i)
        if (i > -1) {
          v.cssOrder.splice(i, 1) // remove
          v.cssOrder.unshift(appKey) // place at beginning
          v[eqKey] = Math.random()
        }
        return v
      })
    },
    minimizeApp () {
      const { visibility, key: appKey, workspaceKey } = this.app$()
      if (visibility !== 'open') throw new Error('Can only minimize an open app')

      this.close() // close menu
      let i
      storage[`session_appByKey_${appKey}_visibility$`]('minimized')
      storage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]((v, eqKey) => {
        i = v.cssOrder.indexOf(appKey)
        if (i > -1) {
          v.cssOrder.splice(i, 1) // remove (to e.g. let 3rd app become 2nd)
          v[eqKey] = Math.random()
        }
        return v
      })
    },
    closeApp () {
      const { visibility, key: appKey, workspaceKey } = this.app$()
      if (visibility === 'closed') throw new Error('App is already closed')

      this.close() // close menu
      storage[`session_appByKey_${appKey}_visibility$`]('closed')
      storage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]((v, eqKey) => {
        let hasUpdated = false
        if (v.domOrder[v.domOrder.length - 1] === appKey) {
          v.domOrder.pop() // safe to remove if last
          hasUpdated = true
        }
        const i = v.cssOrder.indexOf(appKey)
        if (i !== -1) {
          v.cssOrder.splice(i, 1) // remove
          hasUpdated = true
        }
        if (hasUpdated) v[eqKey] = Math.random()
        return v
      })
    },
    removeApp ({ isDeleteStep = false } = {}) {
      const { id: appId, key: appKey, workspaceKey } = this.app$()
      const appKeys = storage[`session_workspaceByKey_${workspaceKey}_appById_${appId}_appKeys$`]()
      if (!isDeleteStep && appKeys.length <= 1) throw new Error('Cannot remove the last instance of an app')
      if (!isDeleteStep) this.close() // close menu

      storage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]((v, eqKey) => {
        let hasUpdated = false
        if (v.domOrder[v.domOrder.length - 1] === appKey) {
          v.domOrder.pop() // safe to remove if last
          hasUpdated = true
        }
        const i = v.cssOrder.indexOf(appKey)
        if (i !== -1) {
          v.cssOrder.splice(i, 1) // remove
          hasUpdated = true
        }
        if (hasUpdated) v[eqKey] = Math.random()
        return v
      })
      const newAppKeys = appKeys.filter(v => v !== appKey)
      storage[`session_workspaceByKey_${workspaceKey}_appById_${appId}_appKeys$`](newAppKeys)
      storage[`session_appByKey_${appKey}_id$`](undefined)
      storage[`session_appByKey_${appKey}_visibility$`](undefined)
      storage[`session_appByKey_${appKey}_route$`](undefined)
    },
    // open iframe at /~~napp#clear to let it clear its idb/localStorage
    // and listen for postMessage to close it and remove bundle and file chunks
    async maybeClearAppStorage () {
      const { id: appId, workspaceKey } = this.app$()
      const userPk = storage[`session_workspaceByKey_${workspaceKey}_userPk$`]() || storage.session_anonPk$()

      const otherWorkspaces = storage.session_workspaceKeys$().filter(wsKey => wsKey !== workspaceKey)
      let shouldClearAppData = true
      let shouldClearAppFiles = true
      for (const wsKey of otherWorkspaces) {
        const hasApp = storage[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]()?.length > 0
        if (hasApp) {
          shouldClearAppFiles = false // app exists in another workspace (same or other user)
          const wsUserPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]() || storage.session_anonPk$()
          if (wsUserPk === userPk) {
            shouldClearAppData = false // same user has app in another workspace
            break // both conditions found
          }
        }
      }

      if (shouldClearAppData) {
        const userPkB36 = base62ToBase36(userPk, 50)
        const appSubdomain = appIdToAppSubdomain(appId, userPkB36)
        await askAppToClearData(appSubdomain)
      }
      if (shouldClearAppFiles) {
        const appFiles = await AppFileManager.create(appId)
        await appFiles.clearAppFiles()
      }

      function askAppToClearData (appSubdomain) {
        const p = Promise.withResolvers()
        const iframe = document.createElement('iframe')
        iframe.style.display = 'none'

        // eslint-disable-next-line prefer-const
        let timeout
        const cleanup = () => {
          if (timeout) clearTimeout(timeout)
          window.removeEventListener('message', onMessage)
          document.body.removeChild(iframe)
        }

        const appOrigin = `${window.location.protocol}//${appSubdomain}.${window.location.host}`
        const onMessage = e => {
          if (e.origin !== appOrigin) return
          if (e.data.code === 'DATA_CLEARED') {
            cleanup()
            p.resolve()
          }
          if (e.data.code === 'DATA_CLEAR_ERROR') {
            cleanup()
            p.reject(e.data.error)
          }
        }
        window.addEventListener('message', onMessage)
        iframe.src = `${appOrigin}/~~napp#clear`
        document.body.appendChild(iframe)

        timeout = setTimeout(() => {
          cleanup()
          p.reject(new Error('Data clear timeout'))
        }, 5000)
        return p.promise
      }
    },
    async deleteApp () {
      const { id: appId, workspaceKey } = this.app$()
      const appKeys = storage[`session_workspaceByKey_${workspaceKey}_appById_${appId}_appKeys$`]()
      if (appKeys.length !== 1) throw new Error('Can only delete an app that has a single instance')
      this.removeApp({ isDeleteStep: true }) // may throw

      this.close() // close menu
      await this.maybeClearAppStorage()
      storage[`session_workspaceByKey_${workspaceKey}_pinnedAppIds$`](v => (v ?? []).filter(v2 => v2 !== appId))
      storage[`session_workspaceByKey_${workspaceKey}_unpinnedAppIds$`](v => (v ?? []).filter(v2 => v2 !== appId))
      storage[`session_workspaceByKey_${workspaceKey}_appById_${appId}_appKeys$`](undefined)
    },
    render: useCallback(function () {
      const {
        openApp,
        bringToFirst,
        minimizeApp,
        closeApp,
        removeApp,
        deleteApp,
        app$
      } = menuProps
      const {
        id: appId,
        key: appKey,
        visibility,
        workspaceKey
      } = app$()
      const { cssOrder } = storage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]()
      const appKeys = storage[`session_workspaceByKey_${workspaceKey}_appById_${appId}_appKeys$`]()
      return this.h`<div id='scope_pfgf892'>
        <style>${`
          #scope_pfgf892 {
            & > div {
              &.invisible { display: none; }
              display: flex;
              align-items: center;
            }
            .icon-wrapper-271yiduh {
              flex: 0 1 min-content;
              margin: 10px;
            }
            .menu-label {
              flex: 1;
              min-height: 30px;
              padding: 10px 10px 10px 3px;
            }
          }
        `}</style>
        <div class=${{ invisible: visibility === 'open' }}>
          <div class='icon-wrapper-271yiduh'><icon-maximize props=${{ size: '16px' }} /></div>
          <div class='menu-label' onclick=${openApp}>${visibility === 'closed' ? 'Open' : 'Maximize'}</div>
        </div>
        <div class=${{ invisible: visibility !== 'open' || cssOrder[0] === appKey }}>
          <div class='icon-wrapper-271yiduh'><icon-stack-front props=${{ size: '16px' }} /></div>
          <div class='menu-label' onclick=${bringToFirst}>Bring to First</div>
        </div>
        <div class=${{ invisible: visibility !== 'open' }}>
          <div class='icon-wrapper-271yiduh'><icon-minimize props=${{ size: '16px' }} /></div>
          <div class='menu-label' onclick=${minimizeApp}>Minimize</div>
        </div>
        <div class=${{ invisible: visibility === 'closed' }}>
          <div class='icon-wrapper-271yiduh'><icon-close props=${{ size: '16px' }} /></div>
          <div class='menu-label' onclick=${closeApp}>Close</div>
        </div>
        <div class=${{ invisible: appKeys.length <= 1 }}>
          <div class='icon-wrapper-271yiduh'><icon-remove props=${{ size: '16px' }} /></div>
          <div class='menu-label' onclick=${removeApp}>Remove</div>
        </div>
        <div class=${{ invisible: appKeys.length !== 1 }}>
          <div class='icon-wrapper-271yiduh'><icon-delete props=${{ size: '16px' }} /></div>
          <div class='menu-label' onclick=${deleteApp}>Delete</div>
        </div>
      </div>`
    }),
    style$: () => {
      const modernCSS = `& {
        position-anchor: --app-launchers-menu;
        position-area: top span-right;
        margin-bottom: 6px;
        @media (orientation: landscape) {
          position-area: left span-bottom;
          margin-right: 7px;
        }
      }`
      const fallbackCSS = `& {
        position: fixed;
        z-index: 1000;
        margin-bottom: 6px;
        @media (orientation: landscape) {
          margin-right: 7px;
        }
      }`
      const commonCSS = `
        background-color: ${cssVars.colors.mg};
        color: ${cssVars.colors.mgFont};
        min-width: 120px;
        display: flex;
        flex-direction: column;
      `

      const anchorCSS = CSS.supports('position-anchor', '--test') ? modernCSS : fallbackCSS
      return `& { ${anchorCSS} ${commonCSS} }`
    },
    anchorRef$: () => menuProps.app$()?.ref
  }))
  return this.h`<a-menu props=${menuProps} />`
})
f(function toolbarAppLauncher () {
  const storage = useWebStorage(localStorage)
  const newAppIdsObj$ = useGlobalSignal('hardcoded_newAppIdsObj')
  const appIndex$ = useStateSignal(this.props.appIndex)
  const appRef$ = useSignal()

  const app$ = useComputed(() => ({
    id: this.props.appId,
    key: this.props.appKey,
    workspaceKey: storage.session_openWorkspaceKeys$()[0],
    index: appIndex$(),
    visibility: storage[`session_appByKey_${this.props.appKey}_visibility$`](),
    icon: storage[`session_appByKey_${this.props.appKey}_icon$`](),
    isNew: !!newAppIdsObj$()[this.props.appId],
    ref: appRef$()
  }))

  const unifiedToolbarRef$ = useClosestSignal('unifiedToolbarRef')
  useLongPress(unifiedToolbarRef$, appRef$)
  const { toggleMenu, app$: currApp$ } = useClosestStore('<a-menu>')
  const onLongPress = () => toggleMenu({ ...app$() })
  const anchorName$ = useComputed(() => currApp$().key === app$().key ? '--app-launchers-menu' : 'none')

  const onClick = useCallback(e => {
    // canceled by longpress
    if (e.shouldStopPropagation) return

    switch (app$().visibility) {
      case 'closed': {
        // open
        storage[`session_appByKey_${app$().key}_visibility$`]('open')
        storage[`session_workspaceByKey_${app$().workspaceKey}_openAppKeys$`]((v, eqKey) => {
          const appKey = app$().key
          if (!v.domOrder.includes(appKey)) {
            v.domOrder.push(appKey) // must not change order of previous windows
          }
          v.cssOrder.unshift(appKey) // place at beginning
          v[eqKey] = Math.random()
          return v
        })
        break
      }
      case 'minimized': {
        // maximize
        const appKey = app$().key
        storage[`session_appByKey_${appKey}_visibility$`]('open')
        storage[`session_workspaceByKey_${app$().workspaceKey}_openAppKeys$`]((v, eqKey) => {
          const i = v.cssOrder.indexOf(appKey)
          if (i !== -1) v.cssOrder.splice(i, 1) // remove
          v.cssOrder.unshift(appKey) // place at beginning
          v[eqKey] = Math.random()
          return v
        })
        break
      }
      case 'open': {
        // bring to front or minimize
        const appKey = app$().key
        storage[`session_workspaceByKey_${app$().workspaceKey}_openAppKeys$`]((v, eqKey) => {
          const i = v.cssOrder.indexOf(appKey)
          if (i > -1) {
            v.cssOrder.splice(i, 1) // remove (to e.g. let 3rd app become 2nd)
            if (i === 0) storage[`session_appByKey_${appKey}_visibility$`]('minimized')
            else v.cssOrder.unshift(appKey) // place at beginning
            v[eqKey] = Math.random()
          }
          return v
        })
        break
      }
    }
  })

  return this.h`<div
    ref=${appRef$}
    onclick=${onClick}
    @custom:longpress=${onLongPress}
    class="scope_df81hd"
    style=${`
      anchor-name: ${anchorName$()};
      background-color: transparent;
      width: 40px;
      height: 40px;
      display: flex;
      justify-content: center;
      align-items: center;
      position: relative;
    `}
  >
    <style>${`
      .scope_df81hd {
        & {
          flex-shrink: 0;
        }
        .squircle {
          position: absolute;
          width: 100%;
          height: 100%;
          z-index: 0;

          path {
            fill: ${cssVars.colors.fg};
            stroke: none;
          }
        }
      }
    `}</style>
    ${this.s`<svg viewbox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" class="squircle">
      <path d="M 0, 100 C 0, 12 12, 0 100, 0 S 200, 12 200, 100 188, 200 100, 200 0, 188 0, 100"></path>
    </svg>`}
    <span style=${`
      display: block;
      z-index: 1;
    `}>${app$().index}</span>
  </div>`
})
