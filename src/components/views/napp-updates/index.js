import { f, useComputed, useSignal, useTask } from '#f'
import '#f/components/f-to-signals.js'
import { cssVars, jsVars } from '#assets/styles/theme.js'
import '#shared/back-btn.js'
import '#shared/app-icon.js'
import '#shared/avatar.js'
import '#shared/icons/icon-reload.js'
import '#shared/icons/icon-arrow-narrow-right.js'
import '#shared/icons/icon-check.js'
import '#shared/icons/icon-exclamation-mark.js'
import '#shared/icons/icon-hourglass-high.js'
import useWebStorage from '#hooks/use-web-storage.js'
import AppFileManager from '#services/app-file-manager/index.js'
import AppUpdater from '#services/app-updater/index.js'
import { getEventsByStrategy } from '#helpers/nostr-queries.js'
import { base16ToBase62 } from '#helpers/base62.js'

f('napp-updates', function () {
  const storage = useWebStorage(localStorage)

  const allAppIds$ = useComputed(() => {
    const workspaceKeys = storage.session_workspaceKeys$() || []
    const appIds = new Set()

    workspaceKeys.forEach(wsKey => {
      const pinned = storage[`session_workspaceByKey_${wsKey}_pinnedAppIds$`]() || []
      const unpinned = storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`]() || []
      pinned.forEach(id => appIds.add(id))
      unpinned.forEach(id => appIds.add(id))
    })

    return Array.from(appIds)
  })

  const publisherProfiles$ = useSignal({})
  const availableUpdates$ = useSignal({})
  const updateStates$ = useSignal({}) // { [appId]: { status: 'idle'|'pending'|'updating'|'done'|'error', progress: 0, error: null } }
  const isUpdatingAll$ = useSignal(false)
  const overallProgress$ = useSignal(0)

  const updatesCount$ = useComputed(() => Object.keys(availableUpdates$()).length)
  const checkedAppsCount$ = useSignal(0)
  const isLoading$ = useComputed(() => checkedAppsCount$() < allAppIds$().length)
  const isSearching$ = useSignal(false)

  const startableUpdateIds$ = useComputed(() => {
    const updates = availableUpdates$()
    const states = updateStates$()
    return Object.keys(updates).filter(id => {
      const status = states[id]?.status
      return status !== 'updating' && status !== 'pending' && status !== 'done'
    })
  })

  const performSearch = async () => {
    if (isSearching$()) return
    isSearching$(true)
    const appIds = allAppIds$()

    try {
      const updates = await AppUpdater.searchForUpdates(appIds)

      availableUpdates$(prev => {
        const next = { ...prev }
        const states = updateStates$()

        Object.entries(updates).forEach(([id, update]) => {
          const status = states[id]?.status
          // Don't overwrite if currently updating
          if (status === 'updating' || status === 'pending') return

          next[id] = update
          // Reset error state if found again
          if (states[id]?.status === 'error') {
            updateStates$(s => {
              const ns = { ...s }
              delete ns[id]
              return ns
            })
          }
        })
        return next
      })
    } catch (e) {
      console.error('Error checking for updates', e)
    } finally {
      checkedAppsCount$(appIds.length)
      isSearching$(false)
    }
  }

  useTask(async () => {
    await performSearch()

    // 2. Fetch profiles
    const appIds = allAppIds$()
    const managers = await Promise.all(appIds.map(id => AppFileManager.create(id).catch(() => null)))
    const pubkeys = new Set()
    managers.forEach(m => {
      if (m?.bundle?.pubkey) pubkeys.add(m.bundle.pubkey)
    })

    // Add pubkeys from updates
    Object.values(availableUpdates$()).forEach(u => {
      if (u.event?.pubkey) pubkeys.add(u.event.pubkey)
    })

    if (pubkeys.size > 0) {
      try {
        const events = await getEventsByStrategy(
          { kinds: [0], authors: Array.from(pubkeys) },
          { code: 'WRITE_RELAYS' }
        )
        const profiles = {}
        events.forEach(e => {
          try { profiles[e.pubkey] = JSON.parse(e.content) } catch {}
        })
        publisherProfiles$(profiles)
      } catch (e) {
        console.error('Bulk fetch failed', e)
      }
    }
  })

  const handleUpdateAll = async () => {
    if (isUpdatingAll$()) return

    const targetIds = startableUpdateIds$()
    if (targetIds.length === 0) return

    isUpdatingAll$(true)
    const updates = availableUpdates$()
    const events = targetIds.map(id => updates[id].event)

    // Initialize states for targets
    updateStates$(prev => {
      const next = { ...prev }
      targetIds.forEach(id => {
        next[id] = { status: 'pending', progress: 0, error: null }
      })
      return next
    })

    try {
      for await (const report of AppUpdater.updateApps(events)) {
        const { appId, appProgress, error, overallProgress } = report
        overallProgress$(overallProgress)

        updateStates$(prev => ({
          ...prev,
          [appId]: {
            status: error ? 'error' : (appProgress === 100 ? 'done' : 'updating'),
            progress: appProgress,
            error
          }
        }))
      }

      // Clear done updates
      availableUpdates$(prev => {
        const next = { ...prev }
        Object.keys(updateStates$()).forEach(id => {
          if (updateStates$()[id].status === 'done') {
            delete next[id]
          }
        })
        return next
      })
    } catch (e) {
      console.error('Update all failed', e)
    } finally {
      isUpdatingAll$(false)
      overallProgress$(0)
    }
  }

  const handleUpdateSingle = async (appId) => {
    const update = availableUpdates$()[appId]
    if (!update) return

    const currentState = updateStates$()[appId]?.status
    if (currentState === 'updating' || currentState === 'pending') return

    updateStates$(prev => ({ ...prev, [appId]: { status: 'updating', progress: 0, error: null } }))

    try {
      for await (const report of AppUpdater.updateApp(update.event)) {
        updateStates$(prev => ({
          ...prev,
          [appId]: {
            status: report.error ? 'error' : 'updating',
            progress: report.appProgress,
            error: report.error
          }
        }))
      }

      updateStates$(prev => ({ ...prev, [appId]: { status: 'done', progress: 100, error: null } }))

      // Remove from available updates
      availableUpdates$(prev => {
        const next = { ...prev }
        delete next[appId]
        return next
      })
    } catch (e) {
      updateStates$(prev => ({ ...prev, [appId]: { status: 'error', error: e, progress: 0 } }))
    }
  }

  return this.h`
    <style>${/* css */`
      napp-updates {
        flex-grow: 1; /* use max width available */
        max-width: 900px;
        display: flex !important;
        flex-direction: column;
        height: 100%;
      }

      .header-1kuhvcxd8b {
        background-color: ${cssVars.colors.bg};
        color: ${cssVars.colors.fg};
        height: 55px;
        display: flex;
        align-items: center;
        padding: 0 10px;
        flex-shrink: 0;

        .btn-wrapper-136713 {
          position: relative;
          bottom: 1px;
          height: 100%;
          display: flex;
          min-width: 34px;

          & button {
            padding-right: 4px;
          }
        }

        .title-gd7a98 {
          flex-grow: 1;
          font-weight: 500;
          font-size: 18rem;
        }

        .actions-wrapper {
          display: flex;
          gap: 8px;
          align-items: center;
        }
      }

      .body-cydfv983dfff {
        flex-grow: 1; /* take remaining height */
        display: flex;
        gap: 13px;
        flex-direction: column;
        overflow-y: auto;
        padding: 10px 0;
      }

      .action-btn {
        padding: 6px 12px;
        border-radius: 4px;
        font-size: 14rem;
        font-weight: 500;
        cursor: pointer;
        transition: background-color 0.2s, opacity 0.2s;
        border: none;
        background-color: ${cssVars.colors.bg2};
        color: ${cssVars.colors.fg};
        display: flex;
        align-items: center;
        justify-content: center;

        &:hover {
          background-color: ${cssVars.colors.bg3};
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      .update-all-btn {
        background-color: ${cssVars.colors.bgAccentPrimary};
        color: ${cssVars.colors.fgAccent};

        &:hover {
          filter: brightness(1.1);
          background-color: ${cssVars.colors.bgAccentPrimary};
        }
      }

      .desktop-update-all {
        @media ${jsVars.breakpoints.mobile} {
          display: none;
        }
      }

      .mobile-updates-bar {
        display: none;
        @media ${jsVars.breakpoints.mobile} {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 20px;
          font-weight: 500;
          color: ${cssVars.colors.fg};
        }
      }

      .no-updates-bar {
        display: flex;
        padding: 10px 20px;
        font-style: italic;
        color: ${cssVars.colors.fg2};
      }

      .search-text {
        @media ${jsVars.breakpoints.mobile} {
          display: none;
        }
      }

      .search-icon {
        display: none;
        @media ${jsVars.breakpoints.mobile} {
          display: flex;
        }
      }

      @keyframes spin { 100% { transform: rotate(360deg); } }
      .spinning { animation: spin 1s linear infinite; }
    `}</style>
    <div class='header-1kuhvcxd8b'>
      <div class='btn-wrapper-136713'>
        <back-btn />
      </div>
      <div class='title-gd7a98'>Napp Updates</div>
      <div class="actions-wrapper">
        <button class="action-btn" onclick=${performSearch} disabled=${isSearching$()}>
          <span class="search-text">${isSearching$() ? 'Searching...' : 'Search for Updates'}</span>
          <span class=${`search-icon ${isSearching$() ? 'spinning' : ''}`}><icon-reload props=${{ size: '20px' }} /></span>
        </button>
        ${updatesCount$() > 0 && !isUpdatingAll$() ? this.h`<button class="action-btn update-all-btn desktop-update-all" onclick=${handleUpdateAll} disabled=${startableUpdateIds$().length === 0}>Update All</button>` : ''}
        ${isUpdatingAll$() ? this.h`<div class="desktop-update-all" style=${`font-size:14rem;color:${cssVars.colors.fg2}`}>Updating... ${overallProgress$()}%</div>` : ''}
      </div>
    </div>
    ${updatesCount$() > 0
      ? this.h`
      <div class="mobile-updates-bar">
        <div>Updates Available</div>
        ${!isUpdatingAll$()
          ? this.h`<button class="action-btn update-all-btn" onclick=${handleUpdateAll} disabled=${startableUpdateIds$().length === 0}>Update All</button>`
          : this.h`<span>${overallProgress$()}%</span>`
        }
      </div>
    `
      : (!isLoading$()
          ? this.h`
      <div class="no-updates-bar">
        No Updates Available
      </div>
    `
          : '')}
    <div class='body-cydfv983dfff'>
      ${allAppIds$().map(appId => this.h({ key: appId })`
        <f-to-signals
          key=${appId}
          props=${{
            from: ['updateInfo', 'updateState'],
            updateInfo: availableUpdates$()[appId],
            updateState: updateStates$()[appId],
            appId,
            publisherProfiles$,
            onUpdate: () => handleUpdateSingle(appId),
            render (props) {
              return this.h`<napp-update-card props=${props} />`
            }
          }}
        />
      `)}
      ${allAppIds$().length === 0 ? this.h`<div style=${`padding: 20px; text-align: center; color: ${cssVars.colors.fg2}`}>No apps found</div>` : ''}
    </div>
  `
})

f('napp-update-card', function () {
  const storage = useWebStorage(localStorage)
  const { appId, publisherProfiles$, updateInfo$, updateState$, onUpdate } = this.props

  const appName$ = useComputed(() => {
    return storage[`session_appById_${appId}_name$`]()
  })

  const version$ = useSignal('...')
  const nextVersion$ = useSignal(null)
  const publisherPk$ = useSignal(null)
  const publisherHexPk$ = useSignal(null)

  const publisherPicture$ = useComputed(() => {
    const hex = publisherHexPk$()
    return hex ? publisherProfiles$()[hex]?.picture : null
  })

  useTask(async () => {
    try {
      const appFileManager = await AppFileManager.create(appId)

      if (!appName$()) {
        appFileManager.getName()
      }

      const bundle = appFileManager.bundle
      if (bundle) {
        const date = new Date(bundle.created_at * 1000).toISOString().split('T')[0]
        const shortId = bundle.id.slice(0, 8)
        version$(`${date}-${shortId}`)
      }

      const updateInfo = updateInfo$()
      if (updateInfo?.event) {
        const e = updateInfo.event
        const date = new Date(e.created_at * 1000).toISOString().split('T')[0]
        const shortId = e.id.slice(0, 8)
        nextVersion$(`${date}-${shortId}`)

        if (e.pubkey) {
          publisherPk$(base16ToBase62(e.pubkey))
          publisherHexPk$(e.pubkey)
        }
      } else {
        if (appFileManager.bundle?.pubkey) {
          publisherPk$(base16ToBase62(appFileManager.bundle.pubkey))
          publisherHexPk$(appFileManager.bundle.pubkey)
        }
      }
    } catch (e) {
      console.error('Error fetching app info', e)
      version$('Unknown')
    }
  })

  const updateState = updateState$()
  const isErrorVisible$ = useSignal(false)

  useTask(() => {
    const state = updateState$()
    if (state?.status === 'error') {
      if (!isErrorVisible$()) {
        isErrorVisible$(true)
        setTimeout(() => {
          isErrorVisible$(false)
        }, 7000)
      }
    } else {
      isErrorVisible$(false)
    }
  })

  return this.h`
    <style>${/* css */`
      .card-8d6gfgwh3wl {
        @media ${jsVars.breakpoints.mobile} {
          margin: 0 10px;
        }
        margin: 0 20px;

        padding: 16px;
        background-color: ${cssVars.colors.bg2};
        border-radius: 16px;
        display: flex;
        align-items: center;
        gap: 16px;
      }

      .icon-wrapper {
        width: 48px;
        height: 48px;
        border-radius: 10px;
        overflow: hidden;
        background-color: ${cssVars.colors.bgAvatar};
        flex-shrink: 0;
      }

      .info {
        flex-grow: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .name-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .name {
        font-weight: 600;
        font-size: 16rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: ${cssVars.colors.fg};
      }

      .name-placeholder {
        height: 16rem;
        width: 150px;
        border-radius: 4px;
        background-color: ${cssVars.colors.bg3};
        margin-bottom: 4px;
      }

      @keyframes pulse {
        50% { opacity: .5; }
      }
      .animate-background {
        animation: pulse 2s cubic-bezier(.4,0,.6,1) infinite;
      }

      .version-info {
        font-size: 13rem;
        color: ${cssVars.colors.fg2};
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .current-ver {
        opacity: 0.8;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .publisher-avatar {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background-color: ${cssVars.colors.bgAvatar};
        display: inline-block;
        overflow: hidden;
      }

      .next-ver {
        color: ${cssVars.colors.fg2AccentPrimary};
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .update-btn {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 14rem;
        font-weight: 600;
        cursor: pointer;
        border: none;
        background-color: ${cssVars.colors.bgAccentPrimary};
        color: ${cssVars.colors.fgAccent};
        transition: filter 0.2s;
        white-space: nowrap;

        &:hover {
          filter: brightness(1.1);
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      .progress-circle-container {
        position: relative;
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .progress-circle-svg {
        transform: rotate(-90deg);
        width: 100%;
        height: 100%;
      }

      .progress-circle-bg {
        stroke: ${cssVars.colors.mg2};
      }

      .progress-circle-fg {
        stroke: ${cssVars.colors.bgAccentPrimary};
        transition: stroke-dashoffset 0.3s ease;
      }

      .progress-circle-fg.done {
        stroke: ${cssVars.colors.fgSuccess};
      }

      .progress-circle-fg.error {
        stroke: ${cssVars.colors.fgError};
        animation: error-progress 7s linear forwards;
      }

      @keyframes error-progress {
        from { stroke-dashoffset: 100; }
        to { stroke-dashoffset: 0; }
      }

      .progress-content {
        position: absolute;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12rem;
        font-weight: 600;
        color: ${cssVars.colors.fg};
      }
    `}</style>
    <div class='card-8d6gfgwh3wl'>
      <div class="icon-wrapper">
        <app-icon props=${{ app$: () => ({ id: appId }) }} />
      </div>
      <div class="info">
        <div class="name-row">
          ${publisherPk$() ? this.h`<div class="publisher-avatar"><a-avatar props=${{ usePlaceholder: true, pk$: publisherPk$, picture$: publisherPicture$ }} /></div>` : ''}
          ${appName$()
            ? this.h`<div class="name">${appName$()}</div>`
            : this.h`<div class="name-placeholder animate-background"></div>`
          }
        </div>
        <div class="version-info">
          <span class="current-ver">
            v${version$()}
          </span>
          ${nextVersion$() ? this.h`<span class="next-ver"><icon-arrow-narrow-right props=${{ size: '14px' }} /> v${nextVersion$()}</span>` : ''}
        </div>
      </div>
      ${(updateState?.status === 'updating' || updateState?.status === 'pending' || updateState?.status === 'done' || (updateState?.status === 'error' && isErrorVisible$()))
        ? this.h`
          <div class="progress-circle-container">
            <svg class="progress-circle-svg" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15.9155" fill="none" stroke-width="3" class="progress-circle-bg" />
              <circle cx="18" cy="18" r="15.9155" fill="none" stroke-width="3"
                class=${`progress-circle-fg ${updateState.status === 'done' ? 'done' : ''} ${updateState.status === 'error' ? 'error' : ''}`}
                stroke-dasharray="100"
                stroke-dashoffset=${updateState.status === 'error' ? 100 : (100 - (updateState.status === 'pending' ? 0 : updateState.progress))}
              />
            </svg>
            <div class="progress-content">
              ${updateState.status === 'done'
                ? this.h`<icon-check props=${{ size: '20px', style: 'color:' + cssVars.colors.fgSuccess }} />`
                : (updateState.status === 'error'
                    ? this.h`<icon-exclamation-mark props=${{ size: '20px', style: 'color:' + cssVars.colors.fgError }} />`
                    : (updateState.status === 'pending'
                        ? this.h`<icon-hourglass-high props=${{ size: '20px', style: 'color:' + cssVars.colors.bgAccentSecondary }} />`
                        : Math.round(updateState.progress)
                      )
                  )
              }
            </div>
          </div>
        `
        : (nextVersion$() ? this.h`<button class="update-btn" onclick=${onUpdate}>Update</button>` : '')
      }
    </div>
  `
})
