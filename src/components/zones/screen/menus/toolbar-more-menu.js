import { f, useStore, useGlobalStore } from '#f'
import { cssVars } from '#assets/styles/theme.js'
import '#shared/menu.js'
import '#shared/icons/icon-dots.js'
import '#shared/icons/icon-eye-closed.js'
import '#shared/icons/icon-settings.js'
import '#shared/icons/icon-shopping-bag.js'
import useLocation from '#hooks/use-location.js'
import useWebStorage from '#hooks/use-web-storage.js'

f('toolbar-more-menu', function () {
  const { isHidden$ } = useGlobalStore('toolbarState', { isHidden$: false })
  const { openApp } = useGlobalStore('useAppRouter')
  const { isOpen$, anchorRef$ } = useStore({
    isOpen$: false,
    anchorRef$: null
  })
  const location = useLocation()
  const { session_unread_appUpdateCount$: appUpdateCount$ } = useWebStorage(localStorage)

  const menuProps = useStore({
    isOpen$,
    anchorRef$,
    close: () => isOpen$.set(false),
    fallbackOffset: {
      portrait: { x: -119, y: 5 },
      landscape: { x: -17, y: -15 }
    },
    style$: () => {
      const modernCSS = `& {
        position-anchor: --toolbar-more-menu;
        position-area: top span-left;
        margin-bottom: 1px;
        @media (orientation: landscape) {
          position-area: left span-top;
          margin-right: 2px;
        }
      }`
      const fallbackCSS = `& {
        position: fixed;
        z-index: 1000;
      }`
      const commonCSS = `
        background-color: ${cssVars.colors.bg2};
        color: ${cssVars.colors.fg2};
        min-width: 120px;
        display: flex;
        flex-direction: column;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      `

      const anchorCSS = CSS.supports('position-anchor', '--test') ? modernCSS : fallbackCSS
      return `& { ${anchorCSS} ${commonCSS} } &:not(:popover-open) { display: none; }`
    },
    render: () => this.h`
      <div id='scope_toolbar_more_menu_content'>
        <style>${`
          #scope_toolbar_more_menu_content {
            & > div {
              display: flex;
              align-items: center;
              cursor: pointer;
            }
            .icon-wrapper {
              flex: 0 1 min-content;
              margin: 10px;
            }
            .menu-label {
              flex: 1;
              min-height: 30px;
              padding: 10px 10px 10px 3px;
            }
            icon-eye-closed, icon-settings, icon-shopping-bag {
              color: ${cssVars.colors.fg2};
            }
            .badge-dot {
              width: 8px;
              height: 8px;
              border-radius: 50%;
              background-color: ${cssVars.colors.bgAccentPrimary};
              margin-left: auto;
              margin-right: 10px;
            }
          }
        `}</style>
        <div onclick=${() => {
          isHidden$.set(true)
          isOpen$.set(false)
        }}>
          <div class='icon-wrapper'><icon-eye-closed props=${{ size: '16px' }} /></div>
          <div class='menu-label'>Hide Toolbar</div>
        </div>
        <div onclick=${() => {
          // or location.pushState({}, '', '/+cA99KnC0UCyqHT5oI8fIkoza0jfB1lrvaWKmuh6h2EhTz2nw4R2a5qVNM')
          openApp('/+cA99KnC0UCyqHT5oI8fIkoza0jfB1lrvaWKmuh6h2EhTz2nw4R2a5qVNM')
          isOpen$.set(false)
        }}>
          <div class='icon-wrapper'><icon-shopping-bag props=${{ size: '16px' }} /></div>
          <div class='menu-label'>App Store</div>
        </div>
        <div onclick=${() => {
          location.pushState({}, '', '/settings')
          isOpen$.set(false)
        }}>
          <div class='icon-wrapper'><icon-settings props=${{ size: '16px' }} /></div>
          <div class='menu-label'>Settings</div>
          ${(appUpdateCount$() ?? 0) > 0 ? this.h`<div class='badge-dot'></div>` : ''}
        </div>
      </div>
    `
  })

  return this.h`
    <div
      id='toolbar-more-menu-button'
      ref=${anchorRef$}
      onclick=${() => isOpen$.set(!isOpen$.get())}
      style=${`
        anchor-name: --toolbar-more-menu;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        color: ${cssVars.colors.fg2};
        transition: color 0.2s;
        flex: 0 0 auto;
        align-self: center;
        position: relative;
      `}
      onmouseenter=${(e) => { e.target.style.color = cssVars.colors.fg }}
      onmouseleave=${(e) => { e.target.style.color = cssVars.colors.fg2 }}
    >
      <style>${`
        #toolbar-more-menu-button {
          @media (orientation: portrait) {
            height: 100%;
            icon-dots svg { transform: rotate(90deg); }
            .more-menu-badge {
              top: 9px;
              right: 4px;
            }
          }
          @media (orientation: landscape) {
            width: 100%;
            .more-menu-badge {
              top: 4px;
              right: 9px;
            }
          }
          .more-menu-badge {
            position: absolute;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: ${cssVars.colors.bgAccentPrimary};
            pointer-events: none;
          }
        }
      `}</style>
      <icon-dots props=${{ size: '24px' }} />
      ${(appUpdateCount$() ?? 0) > 0 ? this.h`<div class='more-menu-badge'></div>` : ''}
    </div>
    <a-menu props=${menuProps} />
  `
})

f('toolbar-restore-button', function () {
  const { isHidden$ } = useGlobalStore('toolbarState')

  return this.h`
    <div
      id='toolbar-restore-button'
      class=${{ visible: isHidden$() }}
      onclick=${() => isHidden$.set(false)}
      style=${`
        position: absolute;
        bottom: 0;
        right: 0;
        width: 50px;
        height: 50px;
        z-index: 100;
        cursor: pointer;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.3s ease-in-out;
        overflow: hidden;
      `}
    >
      <style>
        @keyframes gem-glow-anim {
          0% { opacity: 0; }
          20% { opacity: 0.8; }
          100% { opacity: 0; }
        }

        #toolbar-restore-button {
          &.visible {
            pointer-events: auto !important;
            opacity: 1 !important;
          }

          &.visible .gem-glow {
            animation: gem-glow-anim 2s ease-out;
          }
        }
      </style>

      <svg viewBox="0 0 100 100" width="50%" height="50%" style="display: block; position: absolute; bottom: 0; right: 0;">
        <defs>
          <linearGradient id="gemGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#d8b4fe" />
            <stop offset="50%" stop-color="#a855f7" />
            <stop offset="100%" stop-color="#581c87" />
          </linearGradient>
        </defs>

        <path d="M100 0 L100 100 L0 100 Z" fill="url(#gemGradient)" />

        <path d="M100 0 L100 100 L60 60 Z" fill="rgba(255,255,255,0.15)" />
        <path d="M0 100 L100 100 L60 60 Z" fill="rgba(0,0,0,0.2)" />

        <path d="M85 85 L95 15 L15 95 Z" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1" />
      </svg>

      <div class="gem-glow" style=${`
        position: absolute;
        top: 10px;
        right: 0;
        bottom: 0;
        left: 10px;
        background: radial-gradient(circle at 80% 80%, rgba(168, 85, 247, 0.8), transparent 70%);
        opacity: 0;
        pointer-events: none;
        mix-blend-mode: screen;
      `}></div>
    </div>
  `
})
