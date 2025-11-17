import { f, useCallback, useComputed, useStore, useGlobalStore, useGlobalSignal, useStateSignal, useSignal, useClosestSignal, useClosestStore, useTask } from '#f'
import AppFileManager from '#services/app-file-manager/index.js'
import useInitOrResetScreen from './use-init-or-reset-screen.js'
import useWebStorage from '#hooks/use-web-storage.js'
// import useLongPress from '#hooks/use-long-press.js'
import useScrollbarConfig from '#hooks/use-scrollbar-config.js'
import '#shared/menu.js'
import '#shared/avatar.js'
import {
  cssStrings,
  cssClasses,
  cssVars,
  jsVars
} from '#assets/styles/theme.js'
import windowsBackgroundImage from '#assets/media/bg-ostrich-stained-glass.webp'
import useAppRouter from './use-app-router.js'
import { initMessageListener } from '#helpers/window-message/browser/index.js'
import { base62ToBase36 } from '#helpers/base36.js'
import { appIdToAppSubdomain } from '#helpers/app.js'
import { useVaultModalStore, useRequestVaultMessage } from '#zones/vault-modal/index.js'
import { base62ToBase16 } from '#helpers/base62.js'
import '#shared/napp-assets-caching-progress-bar.js'
import '#shared/app-icon.js'
import '#shared/svg.js'
import '#shared/icons/icon-close.js'
import '#shared/icons/icon-minimize.js'
import '#shared/icons/icon-maximize.js'
import '#shared/icons/icon-stack-front.js'
import '#shared/icons/icon-remove.js'
import '#shared/icons/icon-delete.js'
import '#shared/icons/icon-lock.js'

f('aScreen', function () {
  useInitOrResetScreen()
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
      background-color: ${cssVars.colors.bg2};
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

f('systemViews', function () {
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

f('aWindows', function () {
  const {
    // Order is important, that's why we didn't compute from workspaceKeys$
    // Recently opened/clicked first
    session_openWorkspaceKeys$: openWorkspaceKeys$
  } = useWebStorage(localStorage)

  const stableDomOrderWsKeys$ = useSignal([])
  useTask(({ track }) => {
    const nextKeys = track(() => openWorkspaceKeys$())
    stableDomOrderWsKeys$(v => {
      return v.concat(nextKeys.filter(k => !v.includes(k)))
    })
  })
  const mruRankByWsKey$ = useComputed(() => openWorkspaceKeys$().reduce((r, v, i) => ({ ...r, [v]: i + 1 }), {}))

  return this.h`
    ${stableDomOrderWsKeys$().map(workspaceKey =>
      this.h({
        key: workspaceKey
      })`<workspace-window key=${workspaceKey} props=${{ workspaceKey, mruRankByWsKey$ }} />`
    )}
    <windows-background />
  `
})
f('windowsBackground', function () {
  return this.h`
    <div
      id='windows-background'
      style=${`
        background-color: ${cssVars.colors.bg};
        background-image: url(${windowsBackgroundImage});
        background-position: center;
        background-repeat: no-repeat;
        background-size: contain;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        text-align: center;
        padding: clamp(24px, 6vmin, 80px);
        color: ${cssVars.colors.fg2};
        z-index: 0;
        inset: 0;
        position: absolute;
      `}
    >
      <style>${`
        #windows-background {
          @media ${jsVars.breakpoints.desktop} {
            background-origin: content-box;
          }
        }
      `}</style>
      Please open a napp
    </div>
  `
})
f('workspaceWindow', function () {
  const storage = useWebStorage(localStorage)
  // App instances are useful for grouping app icons, but windows are not grouped by app
  // That's why we have openAppKeys$ instead of openAppIds$
  const {
    [`session_workspaceByKey_${this.props.workspaceKey}_openAppKeys$`]: openAppKeys$
  } = storage

  // Calculate stable DOM order at runtime (similar to workspace windows)
  const stableDomOrderAppKeys$ = useSignal([])
  useTask(({ track }) => {
    const nextKeys = track(() => openAppKeys$())
    stableDomOrderAppKeys$(v => {
      return v.concat(nextKeys.filter(k => !v.includes(k)))
    })
  })

  const mruRankByAppKey = useComputed(() =>
    (openAppKeys$() ?? []).reduce((r, v, i) => ({
      ...r,
      [v]: `${this.props.mruRankByWsKey$()[this.props.workspaceKey]}-${i + 1}`
    }), {})
  )()
  return this.h`
    ${stableDomOrderAppKeys$().map(appKey => {
      const mruRank = mruRankByAppKey[appKey]
      return this.h({ key: appKey })`
      <app-window key=${appKey} props=${{ appKey, wsKey: this.props.workspaceKey, mruRank }} />
      `
    })}
  `
})
f('appWindow', function () {
  const storage = useWebStorage(localStorage)
  const {
    [`session_appByKey_${this.props.appKey}_id$`]: appId$,
    [`session_appByKey_${this.props.appKey}_visibility$`]: appVisibility$,
    [`session_appByKey_${this.props.appKey}_route$`]: initialRoute$,
    [`session_workspaceByKey_${this.props.wsKey}_userPk$`]: userPk$
  } = storage
  const userPkB36$ = useComputed(() => (userPk$() || '') && base62ToBase36(userPk$(), 50))
  const appSubdomain$ = useComputed(() => appIdToAppSubdomain(appId$(), userPkB36$()))
  const isClosed$ = useComputed(() => appVisibility$() === 'closed')
  const trustedAppIframeRef$ = useSignal(null)
  const trustedAppIframeSrc$ = useSignal('about:blank')
  const appIframeRef$ = useSignal(null)
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
  const pdStore = useGlobalStore('<permission-dialog>')
  const { requestPermission } = pdStore
  const { openApp } = useGlobalStore('useAppRouter')

  useTask(
    async ({ track, cleanup }) => {
      const [isClosed, iframeRef] = track(() => [isClosed$(), trustedAppIframeRef$()])
      // This component won't load when app starts closed
      // because stableDomOrderAppKeys$ initially is populated
      // by open (or minimized) apps
      // but will be reused on re-opening: open->closed->open
      if (isClosed) {
        cachingProgress$({}) // reset
        trustedAppIframeRef$(null)
        appIframeSrc$('about:blank')
        appIframeRef$(null)
        trustedAppIframeSrc$('about:blank')
        return
      }
      // without this check, `e.source !== trustedAppPageIframe.contentWindow`
      // may be true after closing then re-opening the app, because useTask
      // runs before rendering on subsequent calls ({ after: 'rendering' }
      // useTask's config is just for the first call)
      if (!iframeRef) return

      const initialRoute = initialRoute$() || ''
      if (initialRoute) initialRoute$('') // reset
      const ac = new AbortController()
      cleanup(() => ac.abort())
      await initMessageListener(
        userPkB36$(), appId$(), appSubdomain$(), initialRoute,
        trustedAppIframeRef$(), appIframeRef$(), appIframeSrc$,
        cachingProgress$, requestVaultMessage, requestPermission, openApp,
        { signal: ac.signal, isSingleNapp: false }
      )
      trustedAppIframeSrc$(`//${appSubdomain$()}.${window.location.host}/~~napp`)
    },
    { after: 'rendering' }
  )

  if (isClosed$()) return

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
        &.mru-rank-1-1 { order: 0; }
        &.mru-rank-1-2 { order: 1; }
        &.mru-rank-1-3 { order: 2; }
        &.mru-rank-2-1 { order: 3; }
        &.mru-rank-2-2 { order: 4; }
        &.mru-rank-2-3 { order: 5; }
        &.mru-rank-3-1 { order: 6; }
        &.mru-rank-3-2 { order: 7; }
        &.mru-rank-3-3 { order: 8; }
        &.mru-rank-1-1.open, &.mru-rank-2-1.open, &.mru-rank-3-1.open {
          display: block;
        }
        #screen.multi-window &.open {
          &.mru-rank-1-2, &.mru-rank-2-2, &.mru-rank-3-2 {
            display: block;
          }
          /* thin or thinner (shrinking number) */
          @media (max-aspect-ratio: 8/16) {
            &.mru-rank-1-3, &.mru-rank-2-3, &.mru-rank-3-3 {
              display: block;
            }
          }
          /* short or shorter (growing number) */
          @media (min-aspect-ratio: 16/8) {
            &.mru-rank-1-3, &.mru-rank-2-3, &.mru-rank-3-3 {
              display: block;
            }
          }
        }
      }
    </style>
    <napp-assets-caching-progress-bar />
    <iframe
      class='napp-page'
      allow='fullscreen; screen-wake-lock; ambient-light-sensor;
             autoplay; midi; encrypted-media;
             accelerometer; gyroscope; magnetometer; xr-spatial-tracking;
             clipboard-read; clipboard-write; web-share;
             camera; microphone;
             geolocation;
             bluetooth;
             payment'
      ref=${appIframeRef$}
      src=${appIframeSrc$()}
    />
    <iframe
      class='tilde-tilde-napp-page'
      ref=${trustedAppIframeRef$}
      src=${trustedAppIframeSrc$()}
    />
    </div>
  `
})

// multi-window or not, we use a single toolbar
// if multi-window we update its content with the
// last selected workspace (a user may have many workspaces)
f('unifiedToolbar', function () {
  const scrollbar$ = useScrollbarConfig()

  return this.h`
    <style>${`
      /* @scope { */
      #unified-toolbar {
        toolbar-active-avatar {
          flex: 0 0 auto;
          display: flex !important;

          @media (orientation: portrait) {
            padding-left: 7px; */
          }
          @media (orientation: landscape) {
            flex-direction: column;
            padding-top: 7px; */
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

f('toolbarActiveAvatar', function () {
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
f('toolbarMenu', function () {
  const storage = useWebStorage(localStorage)
  const { session_openWorkspaceKeys$: openWorkspaceKeys$, session_workspaceKeys$: workspaceKeys$ } = storage
  const { close: closeMenu } = useClosestStore('<a-menu>')
  const vaultModalStore = useVaultModalStore()
  const { requestVaultMessage } = useRequestVaultMessage()

  // Track unlocking state for each user
  const unlockingUsers$ = useSignal({})
  const unlockErrors$ = useSignal({})

  const defaultUserPk$ = storage.session_defaultUserPk$
  // Get all users from workspaces (allowing duplicates)
  const allUsers$ = useComputed(() => {
    const users = []
    const userCounts = {} // Track count for each user

    // Process all workspaces to get all users (including duplicates)
    workspaceKeys$().forEach((wsKey) => {
      const userPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
      if (userPk !== undefined && userPk !== null) {
        const profile = storage[`session_accountByUserPk_${userPk}_profile$`]()
        const isLocked = storage[`session_accountByUserPk_${userPk}_isLocked$`]()

        // Initialize count for this user if not seen before
        if (userCounts[userPk] === undefined) {
          userCounts[userPk] = 0
        }

        // Increment count for this user
        userCounts[userPk]++

        users.push({
          userPk,
          wsKey,
          profile,
          name: profile?.name || profile?.npub || (userPk !== defaultUserPk$() && base62ToBase16(userPk)) || 'Default User',
          isLocked,
          index: userCounts[userPk], // User-specific index (1-indexed)
          totalCount: userCounts[userPk] // Current count (will be final after loop)
        })
      }
    })

    // Update totalCount to the final count for each user
    const finalUserCounts = {}
    users.forEach(user => {
      if (finalUserCounts[user.userPk] === undefined) {
        finalUserCounts[user.userPk] = 0
      }
      finalUserCounts[user.userPk]++
    })

    // Update each user with the final count
    users.forEach(user => {
      user.totalCount = finalUserCounts[user.userPk]
    })

    return users
  })

  // Get current active user
  const activeUserPk$ = useComputed(() => {
    const wsKey = openWorkspaceKeys$()[0]
    return storage[`session_workspaceByKey_${wsKey}_userPk$`]()
  })

  const { disableStartAtVaultHomeWorkaroundThisTime } = useGlobalStore('vaultMessenger')
  const handleUserClick = useCallback(async (userPk, wsKey, isLocked) => {
    if (userPk !== activeUserPk$()) {
      // Switch user: move this user's workspace to the head of openWorkspaceKeys$
      const currentOpenWorkspaceKeys = [...openWorkspaceKeys$()]
      const newOpenWorkspaceKeys = [wsKey, ...currentOpenWorkspaceKeys.filter(key => key !== wsKey)]
      storage.session_openWorkspaceKeys$(newOpenWorkspaceKeys)
    }

    // If user is locked, try to unlock
    if (isLocked) {
      const userKey = `${userPk}-${wsKey}`
      unlockingUsers$({ ...unlockingUsers$(), [userKey]: true })
      unlockErrors$({ ...unlockErrors$(), [userKey]: null })

      try {
        const userPkB16 = base62ToBase16(userPk)
        const response = await requestVaultMessage(
          { code: 'UNLOCK_ACCOUNT', payload: { pubkey: userPkB16 } },
          { timeout: 120000, instant: true }
        )

        if (response.error || !response.payload?.isRouteReady) {
          throw new Error(response.error?.message || 'Failed to unlock account')
        }

        closeMenu()
        // cause above message makes vault navigate to unlock route
        disableStartAtVaultHomeWorkaroundThisTime()
        vaultModalStore.open()
      } catch (error) {
        // Show error message
        unlockErrors$({ ...unlockErrors$(), [userKey]: error.message || 'Error unlocking' })

        // Clear error after 3 seconds
        setTimeout(() => {
          unlockErrors$(prev => {
            const newErrors = { ...prev }
            delete newErrors[userKey]
            return newErrors
          })
        }, 3000)
      } finally {
        // Clear unlocking state
        unlockingUsers$(prev => {
          const newUnlocking = { ...prev }
          delete newUnlocking[userKey]
          return newUnlocking
        })
      }
    } else {
      closeMenu()
    }
  })

  const handleAddUserClick = useCallback(() => {
    closeMenu()
    vaultModalStore.open()
  })

  const menuStore = useClosestStore('<a-menu>')
  const menuProps = useStore({
    render: useCallback(function () {
      return this.h`<div id='user-selection-menu'>
        <style>${`
          #user-selection-menu {
            display: flex;
            flex-direction: column;
            padding: 4px;
            min-width: 200px;
            max-width: 230px;
            background-color: ${cssVars.colors.bg2};
            color: ${cssVars.colors.fg2};
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            overflow: hidden;

            .user-item {
              border-radius: 6px;
              display: flex;
              align-items: center;
              padding: 5px 8px;
              cursor: pointer;
              transition: background-color 0.2s;
            }
            .user-item.active {
              background-color: rgba(255, 255, 255, 0.05);
            }
            .user-item:hover {
              background-color: rgba(255, 255, 255, 0.1);
            }
            .user-avatar {
              margin-right: 12px;
              flex-shrink: 0;
              width: 40px;
              height: 40px;
              position: relative;
            }
            .user-name {
              font-size: 15rem;
              font-weight: 600;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }
            .user-unlock-hint {
              font-size: 12rem;
              font-style: italic;
              color: rgba(255, 255, 255, 0.6);
              margin-top: 2px;
            }
            .user-unlock-error {
              font-size: 12rem;
              font-style: italic;
              color: ${cssVars.colors.fgError};
              margin-top: 2px;
            }
            .user-item.unlocking {
              animation: pulsate 2s ease-in-out infinite;
            }
            @keyframes pulsate {
              0% { background-color: rgba(255, 255, 255, 0.05); }
              50% { background-color: rgba(255, 255, 255, 0.15); }
              100% { background-color: rgba(255, 255, 255, 0.05); }
            }
            .user-index-badge {
              position: absolute;
              bottom: -2px;
              left: -2px;
              width: 16px;
              height: 16px;
              background-color: ${cssVars.colors.bgAccentSecondary};
              border-radius: 50%;
              display: flex;
              justify-content: center;
              align-items: center;
              color: white;
              font-size: 10px;
              font-weight: bold;
            }
            .lock-icon {
              position: absolute;
              bottom: -2px;
              right: -2px;
              width: 16px;
              height: 16px;
              background-color: ${cssVars.colors.bgAccentPrimary};
              border-radius: 50%;
              display: flex;
              justify-content: center;
              align-items: center;
              color: white;
            }
            .lock-icon svg {
              width: 10px;
              height: 10px;
            }
            .add-user-button {
              border-radius: 6px;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 5px 8px;
              cursor: pointer;
              transition: background-color 0.2s;
              margin-top: 4px;
              background-color: rgba(255, 255, 255, 0.05);
            }
            .add-user-button:hover {
              background-color: rgba(255, 255, 255, 0.1);
            }
            .add-user-icon {
              width: 20px;
              height: 20px;
              display: flex;
              justify-content: center;
              align-items: center;
              border-radius: 50%;
              border: 2px solid ${cssVars.colors.fg2};
              color: ${cssVars.colors.fg2};
              flex-shrink: 0;
            }
            .add-user-icon svg {
              width: 12px;
              height: 12px;
            }
          }
        `}</style>
        ${allUsers$().map(user => {
          const userKey = `${user.userPk}-${user.wsKey}`
          const isUnlocking = unlockingUsers$()[userKey]
          const errorMessage = unlockErrors$()[userKey]

          return this.h({ key: userKey })`<div
            class=${{
              'user-item': true,
              active: user.userPk === activeUserPk$(),
              unlocking: isUnlocking
            }}
            onclick=${() => handleUserClick(user.userPk, user.wsKey, user.isLocked)}
          >
            <div class="user-avatar">
              <a-avatar props=${{ pk$: user.userPk, size: '32px', weight$: 'duotone', strokeWidth$: 1 }} />
              ${user.totalCount > 1
                ? this.h`<div class="user-index-badge">${user.index}</div>`
                : ''}
              ${user.isLocked
                ? this.h`<div class="lock-icon">
                    <icon-lock props=${{ size: '10px' }} />
                  </div>`
                : ''}
            </div>
            <div>
              <div class="user-name">${user.name}</div>
              ${user.isLocked
                ? this.h`<div class=${errorMessage ? 'user-unlock-error' : 'user-unlock-hint'}>
                    ${errorMessage || 'Touch to unlock'}
                  </div>`
                : ''}
            </div>
          </div>`
        })}
        <div class="add-user-button" onclick=${handleAddUserClick}>
          <div class="add-user-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </div>
        </div>
      </div>`
    }),
    style$: () => {
      const modernCSS = `& {
        position-anchor: --toolbar-avatar-menu;
        position-area: top span-right;
        margin: 0 0 6px -5px;
        @media (orientation: landscape) {
          position-area: left span-bottom;
          margin: -5px 8px 0 0;
        }
      }`
      const fallbackCSS = `& {
        position: fixed;
        z-index: 1000;
        margin: 0 0 6px -5px;
        @media (orientation: landscape) {
          margin: -5px 8px 0 0;
        }
      }`
      return CSS.supports('position-anchor', '--test') ? modernCSS : fallbackCSS
    },
    ...menuStore
  })

  return this.h`<a-menu props=${menuProps} />`
})
f('toolbarAvatar', function () {
  const storage = useWebStorage(localStorage)
  const { session_openWorkspaceKeys$: openWorkspaceKeys$, session_workspaceKeys$: workspaceKeys$ } = storage

  const userPk$ = useComputed(() => {
    const wsKey = openWorkspaceKeys$()[0]
    return storage[`session_workspaceByKey_${wsKey}_userPk$`]()
  })

  const isLocked$ = useComputed(() => {
    const userPk = userPk$()
    return userPk ? storage[`session_accountByUserPk_${userPk}_isLocked$`]() : false
  })

  // Calculate the user index and total count for the active user
  const userIndex$ = useComputed(() => {
    const activeUserPk = userPk$()
    const activeWsKey = openWorkspaceKeys$()[0]

    if (!activeUserPk || !activeWsKey) return { index: 1, showBadge: false }

    // Count how many times this user appears before the active workspace
    let userCount = 0
    let totalCount = 0

    // First pass: count total occurrences
    for (const wsKey of workspaceKeys$()) {
      const wsUserPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
      if (wsUserPk === activeUserPk) {
        totalCount++
      }
    }

    // Second pass: find the index of the active workspace
    for (const wsKey of workspaceKeys$()) {
      const wsUserPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
      if (wsUserPk === activeUserPk) {
        userCount++
        if (wsKey === activeWsKey) {
          break // Found the active workspace, stop counting
        }
      }
    }

    return {
      index: userCount,
      showBadge: totalCount > 1
    }
  })

  const { toggle: toggleMenu, close: closeMenu, anchorRef$ } = useClosestStore('<a-menu>')
  const vaultModalStore = useVaultModalStore()
  const isLoggedIn$ = useComputed(() => userPk$() !== storage.session_defaultUserPk$() || openWorkspaceKeys$().length > 1)
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
      color: ${cssVars.colors.fg2};
      width: 40px; height: 40px; display: flex; justify-content: center; align-items: center;
      border-radius: 50%;
      position: relative;
    `}
  >
    <a-avatar props=${{ pk$: userPk$, size: '32px', weight$: 'duotone', strokeWidth$: 1 }} />
    ${userIndex$().showBadge
      ? this.h`<div style=${`
          position: absolute;
          bottom: -2px;
          left: -2px;
          width: 16px;
          height: 16px;
          background-color: ${cssVars.colors.bgAccentSecondary};
          border-radius: 50%;
          display: flex;
          justify-content: center;
          align-items: center;
          color: white;
          font-size: 10px;
          font-weight: bold;
        `}>
          ${userIndex$().index}
        </div>`
      : ''}
    ${isLocked$()
      ? this.h`<div style=${`
          position: absolute;
          bottom: -2px;
          right: -2px;
          width: 16px;
          height: 16px;
          background-color: ${cssVars.colors.bgAccentPrimary};
          border-radius: 50%;
          display: flex;
          justify-content: center;
          align-items: center;
          color: white;
        `}>
          <icon-lock props=${{ size: '10px' }} />
        </div>`
      : ''}
  </div>`
})

f('toolbarAppList', function () {
  useClosestStore('<a-menu>', () => ({
    isOpenedByLongPress: false,
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
        }, { timeout: 150 })
      }
    }
  }), { isStatic: false })

  return this.h`
    <toolbar-pinned-apps />
    <toolbar-unpinned-apps />
  `
})
f('toolbarPinnedApps', function () {
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
f('toolbarUnpinnedApps', function () {
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
f('appLaunchersMenu', function () {
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
        const i = v.indexOf(appKey)
        if (i !== -1) v.splice(i, 1) // remove
        v.unshift(appKey) // place at beginning
        v[eqKey] = Math.random()
        return v
      })
    },
    bringToFirst () {
      const { visibility, key: appKey, workspaceKey } = this.app$()
      const openAppKeys = storage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]()
      if (visibility !== 'open') throw new Error('Can only bring to first when app is open')
      if (openAppKeys[0] === appKey) throw new Error('App is already first')

      this.close() // close menu
      let i
      storage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]((v, eqKey) => {
        i = v.indexOf(appKey)
        if (i > -1) {
          v.splice(i, 1) // remove
          v.unshift(appKey) // place at beginning
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
        i = v.indexOf(appKey)
        if (i > -1) {
          v.splice(i, 1) // remove (to e.g. let 3rd app become 2nd)
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
        const i = v.indexOf(appKey)
        if (i !== -1) {
          v.splice(i, 1) // remove
          v[eqKey] = Math.random()
        }
        return v
      })
    },
    removeApp ({ isDeleteStep = false } = {}) {
      const { id: appId, key: appKey, workspaceKey } = this.app$()
      const appKeys = storage[`session_workspaceByKey_${workspaceKey}_appById_${appId}_appKeys$`]()
      if (!isDeleteStep && appKeys.length <= 1) throw new Error('Cannot remove the last instance of an app')
      if (!isDeleteStep) this.close() // close menu

      storage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]((v, eqKey) => {
        const i = v.indexOf(appKey)
        if (i !== -1) {
          v.splice(i, 1) // remove
          v[eqKey] = Math.random()
        }
        return v
      })
      const newAppKeys = appKeys.filter(v => v !== appKey)
      storage[`session_workspaceByKey_${workspaceKey}_appById_${appId}_appKeys$`](newAppKeys)
      storage[`session_appByKey_${appKey}_id$`](undefined)
      storage[`session_appByKey_${appKey}_visibility$`](undefined)
      storage[`session_appByKey_${appKey}_route$`](undefined)

      let hasOtherInstances = false
      for (const wsKey of storage.session_workspaceKeys$()) {
        hasOtherInstances = storage[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]()
          .some(v => v !== appKey)
        if (hasOtherInstances) break
      }
      if (hasOtherInstances) return

      storage[`session_appById_${appId}_icon$`](undefined)
      storage[`session_appById_${appId}_name$`](undefined)
      storage[`session_appById_${appId}_description$`](undefined)
      storage[`session_appById_${appId}_relayHints$`](undefined)
    },
    // open iframe at /~~napp#clear to let it clear its idb/localStorage
    // and listen for postMessage to close it and remove bundle and file chunks
    async maybeClearAppStorage () {
      const { id: appId, workspaceKey } = this.app$()
      const userPk = storage[`session_workspaceByKey_${workspaceKey}_userPk$`]()

      const otherWorkspaces = storage.session_workspaceKeys$().filter(wsKey => wsKey !== workspaceKey)
      let shouldClearAppData = true
      let shouldClearAppFiles = true
      for (const wsKey of otherWorkspaces) {
        const hasApp = storage[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]()?.length > 0
        if (hasApp) {
          shouldClearAppFiles = false // app exists in another workspace (same or other user)
          const wsUserPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
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
      storage[`session_workspaceByKey_${workspaceKey}_pinnedAppIds$`](v => (v ?? []).filter(v2 => v2 !== appId))
      storage[`session_workspaceByKey_${workspaceKey}_unpinnedAppIds$`](v => (v ?? []).filter(v2 => v2 !== appId))
      storage[`session_workspaceByKey_${workspaceKey}_appById_${appId}_appKeys$`](undefined)
      await this.maybeClearAppStorage()
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
      const openAppKeys = storage[`session_workspaceByKey_${workspaceKey}_openAppKeys$`]()
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
        <div class=${{ invisible: visibility !== 'open' || openAppKeys[0] === appKey }}>
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
        background-color: ${cssVars.colors.bg2};
        color: ${cssVars.colors.fg2};
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
f('toolbarAppLauncher', function () {
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

  // const unifiedToolbarRef$ = useClosestSignal('unifiedToolbarRef')
  // useLongPress(unifiedToolbarRef$, appRef$)
  const { toggleMenu, app$: currApp$ } = useClosestStore('<a-menu>')
  const onLongPress = () => toggleMenu({ ...app$() })
  const anchorName$ = useComputed(() => currApp$().key === app$().key ? '--app-launchers-menu' : 'none')

  // const onClick = useCallback(e => {
  //   // canceled by longpress
  //   if (e.shouldStopPropagation) return

  //   switch (app$().visibility) {
  //     case 'closed': {
  //       // open
  //       storage[`session_appByKey_${app$().key}_visibility$`]('open')
  //       storage[`session_workspaceByKey_${app$().workspaceKey}_openAppKeys$`]((v, eqKey) => {
  //         const appKey = app$().key
  //         const i = v.indexOf(appKey)
  //         if (i !== -1) v.splice(i, 1) // remove
  //         v.unshift(appKey) // place at beginning
  //         v[eqKey] = Math.random()
  //         return v
  //       })
  //       break
  //     }
  //     case 'minimized': {
  //       // maximize
  //       const appKey = app$().key
  //       storage[`session_appByKey_${appKey}_visibility$`]('open')
  //       storage[`session_workspaceByKey_${app$().workspaceKey}_openAppKeys$`]((v, eqKey) => {
  //         const i = v.indexOf(appKey)
  //         if (i !== -1) v.splice(i, 1) // remove
  //         v.unshift(appKey) // place at beginning
  //         v[eqKey] = Math.random()
  //         return v
  //       })
  //       break
  //     }
  //     case 'open': {
  //       // bring to front or minimize
  //       const appKey = app$().key
  //       storage[`session_workspaceByKey_${app$().workspaceKey}_openAppKeys$`]((v, eqKey) => {
  //         const i = v.indexOf(appKey)
  //         if (i > -1) {
  //           v.splice(i, 1) // remove (to e.g. let 3rd app become 2nd)
  //           if (i === 0) storage[`session_appByKey_${appKey}_visibility$`]('minimized')
  //           else v.unshift(appKey) // place at beginning
  //           v[eqKey] = Math.random()
  //         }
  //         return v
  //       })
  //       break
  //     }
  //   }
  // })

  const squircleColor$ = useComputed(() => {
    const visibility = app$().visibility
    switch (visibility) {
      case 'open':
        return cssVars.colors.bg3Primary
      case 'minimized':
        return cssVars.colors.bg3Secondary
      case 'closed':
      default:
        return cssVars.colors.bg3
    }
  })

  // @custom:longpress=${onLongPress}
  return this.h`<div
    ref=${appRef$}
    onclick=${onLongPress}
    id=${`scope_df81hd_${app$().key}`}
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
      #scope_df81hd_${app$().key} {
        & {
          flex-shrink: 0;
        }
        .squircle {
          position: absolute;
          width: 100%;
          height: 100%;
          z-index: 0;

          path {
            fill: ${squircleColor$()};
            stroke: none;
          }
        }
      }
    `}</style>
    ${this.s`<svg viewbox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" class="squircle">
      <path d="M 0, 100 C 0, 12 12, 0 100, 0 S 200, 12 200, 100 188, 200 100, 200 0, 188 0, 100"></path>
    </svg>`}
    <div style='padding: 4px; width: 100%; height: 100%; z-index: 1; cursor: pointer;'>
      <app-icon props=${{
        app$
      }} />
    </div>
  </div>`
})
