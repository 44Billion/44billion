import { f, toSignal, useComputed, useSignal, useStore, useTask } from '#f'
import { cssVars } from '#assets/styles/theme.js'
import '#shared/menu.js'
import '#shared/avatar.js'
import '#shared/app-icon.js'
import useWebStorage from '#hooks/use-web-storage.js'
import useScrollbarConfig from '#hooks/use-scrollbar-config.js'
import { getT } from '#i18n/index.js'
import { base62ToBase16 } from 'libp2r2p/base62'

export const otherUsersAppGroupsLocales = getLocales()
const t = getT(otherUsersAppGroupsLocales)

// While a group popover is open, the app-launchers-menu must live inside it
// (so the options menu opens as a nested popover and keeps the group open).
// index.js uses this to unmount the toolbar's own app menu at the same time.
export const otherUsersGroupPopoverOpen$ = toSignal(false)

const GROUP_TILE_SIZE = 40
const GROUP_BUBBLE_PREVIEW_COUNT = 4 // mini thumbnails shown on the collapsed bubble
const GROUP_GRID_COLUMNS = 3
const GROUP_GRID_GAP = 6
const GROUP_GRID_ROWS_VISIBLE = 3
const GROUP_GRID_PEEK = 28 // px of the 4th row revealed when there is more content

f('other-users-app-groups', function () {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const {
    session_openWorkspaceKeys$: openWorkspaceKeys$,
    session_defaultUserPk$: defaultUserPk$
  } = storage
  const scrollbar$ = useScrollbarConfig()
  // Measure with the same scrollbar-width the grid uses (thin), so the
  // reserved width always matches the actual scrollbar. On overlay/mobile
  // scrollbars this is 0 and the scrollbar floats over the icons natively.
  const gridScrollbarWidth = (() => {
    if (scrollbar$.get(false).hasOverlay) return 0
    const testEl = document.createElement('div')
    testEl.style.cssText = `
      position: absolute;
      top: -9999px;
      width: 100px;
      height: 100px;
      overflow: scroll;
      scrollbar-width: thin;
      visibility: hidden;
    `
    document.body.appendChild(testEl)
    const width = testEl.offsetWidth - testEl.clientWidth
    testEl.remove()
    return width
  })()
  const { isOpen$, anchorRef$ } = useStore({
    isOpen$: false,
    anchorRef$: null
  })
  const expandedUserPk$ = useSignal(null)

  // One group per distinct user (other than the selected one) with open or
  // minimized app instances across that user's open workspaces. Open
  // instances come first (workspace MRU order), then minimized ones
  // (pinned/unpinned list order).
  const groups$ = useComputed(() => {
    const openWsKeys = openWorkspaceKeys$() ?? []
    const activeWsKey = openWsKeys[0]
    const activeUserPk = activeWsKey
      ? storage[`session_workspaceByKey_${activeWsKey}_userPk$`]()
      : null
    if (!activeUserPk) return []

    const wsKeysByUser = new Map()
    for (const wsKey of openWsKeys.slice(1)) {
      const userPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
      if (!userPk || userPk === activeUserPk) continue
      const wsKeys = wsKeysByUser.get(userPk)
      if (wsKeys) wsKeys.push(wsKey)
      else wsKeysByUser.set(userPk, [wsKey])
    }

    const groups = []
    for (const [userPk, wsKeys] of wsKeysByUser) {
      const instances = []
      const seen = new Set()
      const addInstance = (wsKey, appKey, visibility) => {
        if (seen.has(appKey)) return
        seen.add(appKey)
        const appId = storage[`session_appByKey_${appKey}_id$`]()
        if (!appId) return
        instances.push({ appKey, appId, wsKey, visibility })
      }

      for (const wsKey of wsKeys) {
        const openAppKeys = tabStorage[`session_workspaceByKey_${wsKey}_openAppKeys$`]() ?? []
        for (const appKey of openAppKeys) {
          if (tabStorage[`session_appByKey_${appKey}_visibility$`]() !== 'open') continue
          addInstance(wsKey, appKey, 'open')
        }
      }
      for (const wsKey of wsKeys) {
        const pinnedAppIds = storage[`session_workspaceByKey_${wsKey}_pinnedAppIds$`]() ?? []
        const unpinnedAppIds = storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`]() ?? []
        const orderedAppKeys = [...pinnedAppIds, ...unpinnedAppIds].flatMap(appId =>
          storage[`session_workspaceByKey_${wsKey}_appById_${appId}_appKeys$`]() ?? []
        )
        for (const appKey of orderedAppKeys) {
          if (tabStorage[`session_appByKey_${appKey}_visibility$`]() !== 'minimized') continue
          addInstance(wsKey, appKey, 'minimized')
        }
      }
      if (!instances.length) continue

      const profile = storage[`session_accountByUserPk_${userPk}_profile$`]() ?? null
      groups.push({
        userPk,
        name: profile?.name || profile?.npub ||
          (userPk !== defaultUserPk$() &&
            base62ToBase16(userPk, { mode: 'integer', byteLength: 32 })) ||
          t('Default User'),
        instances
      })
    }
    return groups
  })

  const closeGroup = () => {
    otherUsersGroupPopoverOpen$(false)
    isOpen$.set(false)
  }

  const openGroup = (group, anchor) => {
    if (expandedUserPk$() === group.userPk && isOpen$.get()) {
      closeGroup()
      return
    }
    expandedUserPk$(group.userPk)
    anchorRef$(anchor)
    otherUsersGroupPopoverOpen$(true)
    isOpen$.set(true)
  }

  // Close the popover automatically when the expanded group disappears
  // (its last app was closed, or its user became the selected one).
  useTask(({ track }) => {
    const expandedUserPk = track(() => expandedUserPk$())
    if (!expandedUserPk) return
    const group = track(() => groups$().find(g => g.userPk === expandedUserPk))
    if (group) return
    expandedUserPk$(null)
    closeGroup()
  })

  const menuProps = useStore({
    isOpen$,
    anchorRef$,
    close: closeGroup,
    fallbackOffset: {
      portrait: { x: 0, y: -6 },
      landscape: { x: -6, y: 0 }
    },
    style$: () => {
      const anchorName = expandedUserPk$()
        ? `--other-users-group-${expandedUserPk$()}`
        : '--other-users-group-none'
      const modernCSS = `& {
        position-anchor: ${anchorName};
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
      }`
      const commonCSS = `
        background-color: ${cssVars.colors.bg2};
        color: ${cssVars.colors.fg2};
        min-width: ${GROUP_GRID_COLUMNS * GROUP_TILE_SIZE +
          (GROUP_GRID_COLUMNS - 1) * GROUP_GRID_GAP + 16 + gridScrollbarWidth}px;
        max-width: min(92vw, 240px);
        --duration: 0s; /* avoid a shrinking empty-box flash while closing */
        border-radius: 10px;
        padding: 8px;
        box-shadow: 0 4px 12px ${cssVars.colors.shadowStrong};
      `
      const anchorCSS = CSS.supports('position-anchor', '--test') ? modernCSS : fallbackCSS
      return `& { ${anchorCSS} ${commonCSS} } &:not(:popover-open) { display: none; }`
    },
    render: () => {
      const group = groups$().find(g => g.userPk === expandedUserPk$())
      if (!group) return ''
      return this.h`
        <div id='scope_other_users_group_popover'>
          <style>${`
            #scope_other_users_group_popover {
              .group-header {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 2px 2px 8px;
                min-width: 0;

                .group-avatar {
                  flex: 0 0 auto;
                  width: 18px;
                  height: 18px;
                  border-radius: 50%;
                  overflow: hidden;
                  background-color: ${cssVars.colors.bgAvatar};
                }
                .group-name {
                  font-size: 13rem;
                  font-weight: 600;
                  color: ${cssVars.colors.fg};
                  max-width: ${GROUP_GRID_COLUMNS * GROUP_TILE_SIZE +
                    (GROUP_GRID_COLUMNS - 1) * GROUP_GRID_GAP -
                    18 /* avatar */ - 6 /* gap */ - 4 /* header padding */}px;
                  white-space: nowrap;
                  overflow: hidden;
                  text-overflow: ellipsis;
                  min-width: 0;
                }
              }
              .group-grid {
                display: grid;
                grid-template-columns: repeat(${GROUP_GRID_COLUMNS}, ${GROUP_TILE_SIZE}px);
                gap: ${GROUP_GRID_GAP}px;
                width: ${GROUP_GRID_COLUMNS * GROUP_TILE_SIZE +
                  (GROUP_GRID_COLUMNS - 1) * GROUP_GRID_GAP + gridScrollbarWidth}px;
                max-height: ${GROUP_GRID_ROWS_VISIBLE * GROUP_TILE_SIZE +
                  (GROUP_GRID_ROWS_VISIBLE - 1) * GROUP_GRID_GAP + GROUP_GRID_PEEK}px;
                overflow-y: auto;
                overflow-x: hidden;
                scrollbar-gutter: stable;
                scrollbar-color: ${cssVars.colors.scrollbarThumb} transparent;
                scrollbar-width: thin;
              }
            }
          `}</style>
          <div class='group-header'>
            <div class='group-avatar'><a-avatar props=${{ pk$: () => group.userPk, size: '18px' }} /></div>
            <div class='group-name'>${group.name}</div>
          </div>
          <div class='group-grid'>
            ${group.instances.map((instance, index) => this.h({ key: instance.appKey })`
              <toolbar-app-launcher
                props=${{
                  appId: instance.appId,
                  appKey: instance.appKey,
                  appIndex: index + 1,
                  workspaceKey: instance.wsKey
                }}
              />
            `)}
          </div>
          <app-launchers-menu />
        </div>`
    }
  })

  return this.h`
    <div id='other-users-app-groups' style='display: contents'>
      <style>${`
        #other-users-app-groups {
          .other-users-group-bubble {
            position: relative;
            width: ${GROUP_TILE_SIZE}px;
            height: ${GROUP_TILE_SIZE}px;
            flex-shrink: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            cursor: pointer;
            border-radius: 10px;

            &:hover .group-bubble-squircle path {
              fill-opacity: .8;
            }
            &:focus-visible {
              outline: 2px solid ${cssVars.colors.bgAccentPrimary};
              outline-offset: 1px;
            }
          }
          .group-bubble-squircle {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            z-index: 0;
            pointer-events: none;

            path {
              fill: ${cssVars.colors.bg3};
              fill-opacity: .55;
              stroke: none;
              transition: fill-opacity .2s;
            }
          }
          .group-minis {
            position: relative;
            z-index: 1;
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            width: 30px;
            gap: 2px;

            .group-mini {
              width: 14px;
              height: 14px;
              border-radius: 4px;
              overflow: hidden;
              background-color: ${cssVars.colors.bgAvatar};
              color: ${cssVars.colors.fg3};

              &.minimized {
                opacity: .75;
              }
            }
            .group-more {
              width: 14px;
              height: 14px;
              border-radius: 4px;
              background-color: ${cssVars.colors.bg2};
              color: ${cssVars.colors.fg2};
              font-size: 8rem;
              font-weight: 700;
              display: flex;
              align-items: center;
              justify-content: center;
            }
          }
          .group-single-launcher {
            display: contents;

            toolbar-app-launcher > div {
              /* cancel the toolbar's own launcher-icon compensation: the
                 bubble already shifts as a whole, so the icon must stay
                 centered inside it */
              left: 0;
            }
          }
          .group-owner-avatar {
            position: absolute;
            right: 0;
            bottom: 0;
            z-index: 2;
            width: 13px;
            height: 13px;
            border-radius: 50%;
            overflow: hidden;
            border: 1px solid ${cssVars.colors.bg2};
            background-color: ${cssVars.colors.bgAvatar};
            pointer-events: none; /* decorative badge; never blocks the launcher below */
          }
          ${scrollbar$.get(false).hasOverlay
            ? ''
            : /* css */`
              @media (orientation: landscape) {
                .other-users-group-bubble {
                  /* toolbar-app-list compensates launcher icons by half the
                     scrollbar width; the bubble needs the same shift to stay
                     centered next to them. Single-app bubbles also shift, but
                     their inner launcher icon shift is cancelled above so it
                     doesn't double */
                  position: relative;
                  left: ${Math.floor(scrollbar$.get(false).width / 2)}px;
                }
              }
            `}
        }
      `}</style>
      ${groups$().map(group => {
        const isSingle = group.instances.length === 1
        const previewCount = group.instances.length > GROUP_BUBBLE_PREVIEW_COUNT
          ? GROUP_BUBBLE_PREVIEW_COUNT - 1
          : group.instances.length
        const overflowCount = group.instances.length > GROUP_BUBBLE_PREVIEW_COUNT
          ? group.instances.length - previewCount
          : 0
        return this.h({ key: group.userPk })`
          <div
            class=${'other-users-group-bubble' + (isSingle ? ' single' : '')}
            role=${isSingle ? null : 'button'}
            tabindex=${isSingle ? null : 0}
            aria-label=${isSingle ? null : t('Show {{user}} apps', { user: group.name })}
            style=${isSingle ? null : `anchor-name: --other-users-group-${group.userPk};`}
            onclick=${isSingle ? null : e => openGroup(group, e.currentTarget)}
            onkeydown=${isSingle
              ? null
              : e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  openGroup(group, e.currentTarget)
                }
              }}
          >
            ${this.s`<svg viewbox='0 0 200 200' xmlns='http://www.w3.org/2000/svg' class='group-bubble-squircle'>
              <path d='M 0,100 C 0,12 12,0 100,0 S 200,12 200,100 188,200 100,200 0,188 0,100'></path>
            </svg>`}
            ${isSingle
              ? this.h`
                  <div class='group-single-launcher'>
                    <toolbar-app-launcher
                      props=${{
                        appId: group.instances[0].appId,
                        appKey: group.instances[0].appKey,
                        appIndex: 1,
                        workspaceKey: group.instances[0].wsKey
                      }}
                    />
                  </div>`
              : this.h`
                  <div class='group-minis'>
                    ${group.instances.slice(0, previewCount).map(instance => this.h({ key: instance.appKey })`
                      <div class=${'group-mini' + (instance.visibility === 'minimized' ? ' minimized' : '')}>
                        <app-icon props=${{ app$: () => ({ id: instance.appId, name: '' }) }} />
                      </div>
                    `)}
                    ${overflowCount > 0 ? this.h`<div class='group-more'>+${overflowCount}</div>` : ''}
                  </div>`}
            <div class='group-owner-avatar' aria-hidden='true'>
              <a-avatar props=${{ pk$: () => group.userPk, size: '12px' }} />
            </div>
          </div>`
      })}
      <a-menu props=${menuProps} />
    </div>`
})

function getLocales () {
  return {
    'Default User': {
      en: 'Default User',
      fr: 'Utilisateur par défaut',
      it: 'Utente predefinito',
      de: 'Standardbenutzer',
      es: 'Usuario predeterminado',
      'pt-BR': 'Usuário padrão',
      ru: 'Пользователь по умолчанию',
      'zh-CN': '默认用户',
      'zh-TW': '預設使用者',
      ja: 'デフォルトユーザー',
      ko: '기본 사용자'
    },
    'Show {{user}} apps': {
      en: 'Show {{user}} apps',
      fr: 'Afficher les apps de {{user}}',
      it: 'Mostra le app di {{user}}',
      de: 'Apps von {{user}} anzeigen',
      es: 'Mostrar apps de {{user}}',
      'pt-BR': 'Mostrar apps de {{user}}',
      ru: 'Показать приложения {{user}}',
      'zh-CN': '显示 {{user}} 的应用',
      'zh-TW': '顯示 {{user}} 的應用',
      ja: '{{user}} のアプリを表示',
      ko: '{{user}}의 앱 보기'
    }
  }
}
