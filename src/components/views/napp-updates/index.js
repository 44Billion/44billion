import { f, useComputed, useSignal, useTask } from '#f'
import { cssVars, jsVars } from '#assets/styles/theme.js'
import '#shared/back-btn.js'
import '#shared/app-icon.js'
import '#shared/avatar.js'
import '#shared/icons/icon-reload.js'
import '#shared/icons/icon-arrow-narrow-right.js'
import useWebStorage from '#hooks/use-web-storage.js'
import AppFileManager from '#services/app-file-manager/index.js'
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
  const updatesCount$ = useSignal(0)
  const incrementUpdatesCount = () => updatesCount$(v => v + 1)

  const checkedAppsCount$ = useSignal(0)
  const incrementCheckedAppsCount = () => checkedAppsCount$(v => v + 1)
  const isLoading$ = useComputed(() => checkedAppsCount$() < allAppIds$().length)

  useTask(async () => {
    const appIds = allAppIds$()
    const managers = await Promise.all(appIds.map(id => AppFileManager.create(id).catch(() => null)))
    const pubkeys = new Set()
    managers.forEach(m => {
      if (m?.bundle?.pubkey) pubkeys.add(m.bundle.pubkey)
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
    `}</style>
    <div class='header-1kuhvcxd8b'>
      <div class='btn-wrapper-136713'>
        <back-btn />
      </div>
      <div class='title-gd7a98'>Napp Updates</div>
      <div class="actions-wrapper">
        <button class="action-btn">
          <span class="search-text">Search for Updates</span>
          <span class="search-icon"><icon-reload props=${{ size: '20px' }} /></span>
        </button>
        ${updatesCount$() > 0 ? this.h`<button class="action-btn update-all-btn desktop-update-all">Update All</button>` : ''}
      </div>
    </div>
    ${updatesCount$() > 0
      ? this.h`
      <div class="mobile-updates-bar">
        <div>Updates Available</div>
        <button class="action-btn update-all-btn">Update All</button>
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
      ${allAppIds$().map(appId => this.h`
        <napp-update-card props=${{ appId, publisherProfiles$, onUpdateAvailable: incrementUpdatesCount, onCheckComplete: incrementCheckedAppsCount }} />
      `)}
      ${allAppIds$().length === 0 ? this.h`<div style="padding: 20px; text-align: center; color: ${cssVars.colors.fg2}">No apps found</div>` : ''}
    </div>
  `
})

f('napp-update-card', function () {
  const storage = useWebStorage(localStorage)
  const { appId, publisherProfiles$, onUpdateAvailable, onCheckComplete } = this.props

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

        // Mock update availability
        if (Math.random() > 0.7) {
          nextVersion$(`2025-12-31-${Math.random().toString(36).slice(2, 10)}`)
          onUpdateAvailable?.()
        }

        // Fetch publisher profile
        if (bundle.pubkey) {
          publisherPk$(base16ToBase62(bundle.pubkey))
          publisherHexPk$(bundle.pubkey)
        }
      }
    } catch (e) {
      console.error('Error fetching app info', e)
      version$('Unknown')
    } finally {
      onCheckComplete?.()
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
      ${nextVersion$() ? this.h`<button class="update-btn">Update</button>` : ''}
    </div>
  `
})
