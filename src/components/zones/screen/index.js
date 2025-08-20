import { f, useCallback, useComputed, useStore, useGlobalSignal, useStateSignal, useSignal, useClosestSignal, useClosestStore, useTask } from '#f'
import useInitOrResetScreen from './use-init-or-reset-screen.js'
import useWebStorage from '#hooks/use-web-storage.js'
import useLongPress from '#hooks/use-long-press.js'
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

f(function aScreen () {
  useInitOrResetScreen()
  useAppRouter()

  const isSingleWindow$ = useWebStorage(localStorage).config_isSingleWindow$
  const style$ = useComputed(() => /* css */`
    @scope {
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

  return this.h`
    ${openAppKeys$().map(appKey => this.h({ key: appKey })`
      <app-window key=${appKey} props=${{ appKey, wsKey: this.props.workspaceKey }} />
    `)}
  `
})
f(function appWindow () {
  const storage = useWebStorage(localStorage)
  const {
    [`session_appByKey_${this.props.appKey}_id$`]: appId$,
    [`session_appByKey_${this.props.appKey}_visibility$`]: appVisibility$,
    [`session_workspaceByKey_${this.props.wsKey}_userPk$`]: maybeUserPk$,
    session_anonPk$: anonPk$
  } = storage
  const userPkB36$ = useComputed(() => base62ToBase36(maybeUserPk$() || anonPk$(), 50))
  const appSubdomain$ = useComputed(() => appIdToAppSubdomain(appId$(), userPkB36$()))
  const appIframeRef$ = useSignal()

  useTask(
    ({ cleanup }) => {
      const ac = new AbortController()
      cleanup(() => ac.abort())
      initMessageListener(userPkB36$(), appId$(), appSubdomain$(), appIframeRef$(), ac.signal)
    },
    { after: 'rendering' }
  )

  return this.h`
    <div
      style=${`
        background-color: ${cssVars.colors.bg};
      `}
      class=${{
        open: appVisibility$() === 'open'
      }}
    >
    <style>
      @scope {
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
            border: none;
            height: 100%;
            width: 100%;
          }
        }
        app-window:nth-child(1) > &.open {
          display: block;
        }
        #screen.multi-window &.open {
          app-window:nth-child(2) > & {
            display: block;
          }
          /* thin or thinner (shrinking number) */
          @media (max-aspect-ratio: 8/16) {
            app-window:nth-child(3) > &.open {
              display: block;
            }
          }
          /* short or shorter (growing number) */
          @media (min-aspect-ratio: 16/8) {
            app-window:nth-child(3) > &.open {
              display: block;
            }
          }
        }
      }
    </style>
    <iframe
      allowtransparency
      ref=${appIframeRef$}
      src=${`//${appSubdomain$()}.${window.location.host}/~~napp`} />
    </div>
  `
})

// multi-window or not, we use a single toolbar
// if multi-window we update its content with the
// last selected workspace (a user may have many workspaces)
f(function unifiedToolbar () {
  return this.h`
    <style>
      @scope {
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
          @media (orientation: landscape) {
            flex-direction: column;
          }
          align-items: center;
          background-color: green;
        }
        /**/
      }
    </style>
    <toolbar-active-avatar />
    <toolbar-app-list />
  `
})

f(function toolbarActiveAvatar () {
  useClosestStore('<a-menu>', {
    isOpen$: false,
    open: function () { this.isOpen$(true) },
    close: function () { this.isOpen$(false) },
    toggle: function () { this.isOpen$(v => !v) }
  })

  return this.h`
    <toolbar-menu />
    <toolbar-avatar />
  `
})
f(function toolbarMenu () {
  const {
    session_workspaceKeys$: workspaceKeys$
  } = useWebStorage(localStorage)

  const menuProps = useStore({
    render: useCallback(function () {
      return this.h`<div>User Menu</div>`
      return workspaceKeys$().map(workspaceKey =>
        this.h({ key: workspaceKey })`<user-option key=${workspaceKey} props=${{ workspaceKey }} />`
      )
    }),
    style$: () => `& {
      position-anchor: --toolbar-avatar-menu;
      position-area: top span-right;
      @media (orientation: landscape) {
        position-area: left span-bottom;
      }
    }`,
    ...useClosestStore('<a-menu>')
  })

  return this.h`<a-menu props=${menuProps} />`
})
f(function toolbarAvatar () {
  const storage = useWebStorage(localStorage)
  const { session_openWorkspaceKeys$: openWorkspaceKeys$ } = storage
  const userPk$ = useComputed(() => {
    const wsKey = openWorkspaceKeys$()[0]
    return storage[`workspaceByKey_${wsKey}_userPk$`]()
  })
  const { toggle } = useClosestStore('<a-menu>')

  return this.h`<div
    onclick=${toggle}
    style=${`
      anchor-name: --toolbar-avatar-menu;
      color: ${cssVars.colors.mgFont};
      width: 40px; height: 40px; display: flex; justify-content: center; align-items: center;
      border-radius: 50%;
    `}
  >
    <a-avatar props=${{ pk$: userPk$(), size: '32px', weight$: 'duotone', strokeWidth$: 1 }} />
  </div>`
})

f(function toolbarAppList () {
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

  return this.h`${appIdsdKeysIndexes$().map(v => this.h({ key: v.appKey })`<toolbar-app-launcher key=${v.appKey} props=${v} />`)}`
})
f(function toolbarAppLauncher () {
  const storage = useWebStorage(localStorage)
  const newAppIdsObj$ = useGlobalSignal('hardcoded_newAppIdsObj')
  const appIndex$ = useStateSignal(this.props.appIndex)
  const appRef$ = useSignal()
  // const menu = useClosestStore('toolbarAppMenu')

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
  const onLongPress = () => console.log('menu.openMenu({ app$ })')

  const onClick = useCallback(e => {
    // canceled by longpress
    if (e.shouldStopPropagation) return

    switch (app$().visibility) {
      case 'closed': {
        // open
        storage[`session_appByKey_${app$().key}_visibility$`]('open')
        storage[`session_workspaceByKey_${app$().workspaceKey}_openAppKeys$`](v => {
          v.unshift(app$().key)
          return v
        })
        break
      }
      case 'minimized': {
        // maximize
        const appKey = app$().key
        storage[`session_appByKey_${appKey}_visibility$`]('open')
        storage[`session_workspaceByKey_${app$().workspaceKey}_openAppKeys$`]((v, eqKey) => {
          const i = v.indexOf(appKey)
          if (i !== -1) {
            v.splice(i, 1) // remove
            v.unshift(appKey) // place at beginning
            v[eqKey] = Math.random()
          }
          return v
        })
        break
      }
      case 'open': {
        // close
        const appKey = app$().key
        storage[`session_appByKey_${appKey}_visibility$`]('minimized')
      }
    }
  })

  return this.h`<div
    ref=${appRef$}
    onclick=${onClick}
    @custom:longpress=${onLongPress}
    style=${`
      background-color: ;
      width: 40px;
      height: 40px;
      display: flex;
      justify-content: center;
      align-items: center;
      position: relative;
    `}
  >
    <style>${`
      @scope {
        & {
          @media (orientation: portrait) {
            margin-left: 7px;
          }
          @media (orientation: landscape) {
            margin-top: 7px;
          }
          /**/
        }
        .squircle {
          position: absolute;
          width: 100%;
          height: 100%;
          z-index: 0;

          path {
            fill: ${cssVars.colors.fg};
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
