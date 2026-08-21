import { f, useStore, useGlobalStore, useComputed, useSignal, useTask } from '#f'
import { cssVars } from '#assets/styles/theme.js'
import '#shared/menu.js'
import '#shared/icons/icon-dots.js'
import '#shared/icons/icon-eye-closed.js'
import '#shared/icons/icon-settings.js'
import '#shared/icons/icon-shopping-bag.js'
import '#shared/icons/icon-reload.js'
import { useLocation } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import { getT } from '#i18n/index.js'
import { launcherUpdateLocales } from '#i18n/launcher-update.js'
import { applyLauncherUpdate, launcherUpdateState$ } from '#services/launcher-sw-manager.js'

export const toolbarMoreMenuLocales = getLocales()
const t = getT({ ...toolbarMoreMenuLocales, ...launcherUpdateLocales })

// Tracks whether the "Hide Toolbar" action entered browser fullscreen, so an
// external exit (ESC, gesture) can reveal the toolbar again.
let toolbarFullscreen = false
const WATERMARK_DELAY_MS = 3000
// Translucent ice palette for the watermark state (like a TV channel logo
// over content): desaturated, with the silhouette/contours still visible.
const ICE_GRADIENT_START = 'oklch(0.97 0.02 245 / 0.42)'
const ICE_GRADIENT_MIDDLE = 'oklch(0.9 0.04 235 / 0.36)'
const ICE_GRADIENT_END = 'oklch(0.8 0.05 225 / 0.3)'
const ICE_HIGHLIGHT = 'oklch(1 0 0 / 0.5)'
const ICE_SHADE = 'oklch(0.72 0.04 235 / 0.34)'
const ICE_STROKE = 'oklch(0.97 0.02 245 / 0.7)'

function isDocumentFullscreen () {
  return !!(document.fullscreenElement || document.webkitFullscreenElement)
}

function requestToolbarFullscreen () {
  const root = document.documentElement
  const request = root.requestFullscreen ?? root.webkitRequestFullscreen
  if (!request || isDocumentFullscreen()) return
  const promise = request.call(root)
  if (promise?.then) {
    promise.then(() => { toolbarFullscreen = true }).catch(() => {})
  } else {
    // Legacy webkit API without a promise: assume it entered fullscreen.
    toolbarFullscreen = true
  }
}

function exitToolbarFullscreen () {
  if (!isDocumentFullscreen()) return
  const exit = document.exitFullscreen ?? document.webkitExitFullscreen
  exit?.call(document).catch?.(() => {})
}

f('toolbar-more-menu', function () {
  const { isHidden$ } = useGlobalStore('toolbarState', { isHidden$: false })
  const { openApp } = useGlobalStore('useAppRouter')
  const { isOpen$, anchorRef$ } = useStore({
    isOpen$: false,
    anchorRef$: null
  })
  const location = useLocation()
  const {
    session_unread_appUpdateCount$: appUpdateCount$,
    config_appUpdateMode$: appUpdateMode$
  } = useWebStorage(localStorage)
  const showUpdateIndicator$ = useComputed(() =>
    (appUpdateMode$() ?? 'always') === 'manual' && (appUpdateCount$() ?? 0) > 0
  )
  const launcherUpdatePending$ = useComputed(() =>
    launcherUpdateState$() === 'dismissed'
  )

  useTask(({ cleanup }) => {
    const onFullscreenChange = () => {
      if (toolbarFullscreen && !isDocumentFullscreen()) {
        toolbarFullscreen = false
        isHidden$.set(false)
      }
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    document.addEventListener('webkitfullscreenchange', onFullscreenChange)
    cleanup(() => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
    })
  })

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
        box-shadow: 0 4px 12px ${cssVars.colors.shadowStrong};
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
        ${launcherUpdatePending$()
          ? this.h`
          <div onclick=${() => {
            applyLauncherUpdate()
            isOpen$.set(false)
          }}>
            <div class='icon-wrapper'><icon-reload props=${{ size: '16px' }} /></div>
            <div class='menu-label'>${t('Update')}</div>
            <div class='badge-dot'></div>
          </div>
        `
          : ''}
        <div onclick=${() => {
          isHidden$.set(true)
          isOpen$.set(false)
          requestToolbarFullscreen()
        }}>
          <div class='icon-wrapper'><icon-eye-closed props=${{ size: '16px' }} /></div>
          <div class='menu-label'>${t('Hide Toolbar')}</div>
        </div>
        <div onclick=${() => {
          // or location.pushState({}, '', '/+3swFhu23QNl8er5yOtc8bf9ueHCdwF8CzoDUiSSwwKIWoS8Ki5TwMyeA3Js1')
          openApp('/+3swFhu23QNl8er5yOtc8bf9ueHCdwF8CzoDUiSSwwKIWoS8Ki5TwMyeA3Js1')
          isOpen$.set(false)
        }}>
          <div class='icon-wrapper'><icon-shopping-bag props=${{ size: '16px' }} /></div>
          <div class='menu-label'>${t('App Store')}</div>
        </div>
        <div onclick=${() => {
          location.pushState({}, '', '/settings')
          isOpen$.set(false)
        }}>
          <div class='icon-wrapper'><icon-settings props=${{ size: '16px' }} /></div>
          <div class='menu-label'>${t('Settings')}</div>
          ${showUpdateIndicator$() ? this.h`<div class='badge-dot'></div>` : ''}
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
      ${showUpdateIndicator$() || launcherUpdatePending$() ? this.h`<div class='more-menu-badge'></div>` : ''}
    </div>
    <a-menu props=${menuProps} />
  `
})

f('toolbar-restore-button', function () {
  const { isHidden$ } = useGlobalStore('toolbarState')
  const isWatermark$ = useSignal(false)

  // After a few seconds the restore button fades into an ice watermark
  // (translucent white-blue gradient with visible contours), so it does not
  // draw attention away from an app behind it. It still reacts to hover/tap.
  useTask(({ track, cleanup }) => {
    const visible = track(() => isHidden$())
    let timerId = null
    cleanup(() => {
      if (timerId) clearTimeout(timerId)
      isWatermark$(false)
    })
    if (!visible) return
    timerId = setTimeout(() => isWatermark$(true), WATERMARK_DELAY_MS)
  })

  return this.h`
    <div
      id='toolbar-restore-button'
      class=${{ visible: isHidden$(), watermark: isWatermark$() }}
      onclick=${() => {
        exitToolbarFullscreen()
        isHidden$.set(false)
      }}
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
        transition: opacity 0.3s ease-in-out, filter 0.6s ease-in-out;
        overflow: hidden;
      `}
    >
      <style>${/* css */`
        @keyframes gem-glow-anim {
          0% { opacity: 0; }
          20% { opacity: 0.8; }
          100% { opacity: 0; }
        }

        #toolbar-restore-button {
          stop {
            transition: stop-color 0.6s ease-in-out;
          }

          &.visible {
            pointer-events: auto !important;
            opacity: 1 !important;
          }

          &.visible .gem-glow {
            animation: gem-glow-anim 2s ease-out;
          }

          &.watermark {
            #gemGradient stop:nth-child(1) { stop-color: ${ICE_GRADIENT_START}; }
            #gemGradient stop:nth-child(2) { stop-color: ${ICE_GRADIENT_MIDDLE}; }
            #gemGradient stop:nth-child(3) { stop-color: ${ICE_GRADIENT_END}; }
            .gem-highlight { fill: ${ICE_HIGHLIGHT}; }
            .gem-shade { fill: ${ICE_SHADE}; }
            .gem-stroke { stroke: ${ICE_STROKE}; }
          }

          &.visible:hover,
          &:active {
            opacity: 1 !important;
            #gemGradient stop:nth-child(1) { stop-color: ${cssVars.colors.artworkPurpleStart}; }
            #gemGradient stop:nth-child(2) { stop-color: ${cssVars.colors.artworkPurpleMiddle}; }
            #gemGradient stop:nth-child(3) { stop-color: ${cssVars.colors.artworkPurpleEnd}; }
            .gem-highlight { fill: ${cssVars.colors.artworkHighlight}; }
            .gem-shade { fill: ${cssVars.colors.artworkShade}; }
            .gem-stroke { stroke: ${cssVars.colors.artworkStroke}; }
          }
        }
      `}</style>

      <svg viewBox="0 0 100 100" width="50%" height="50%" style="display: block; position: absolute; bottom: 0; right: 0;">
        <defs>
          <linearGradient id="gemGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color=${cssVars.colors.artworkPurpleStart} />
            <stop offset="50%" stop-color=${cssVars.colors.artworkPurpleMiddle} />
            <stop offset="100%" stop-color=${cssVars.colors.artworkPurpleEnd} />
          </linearGradient>
        </defs>

        <path d="M100 0 L100 100 L0 100 Z" fill="url(#gemGradient)" />

        <path class="gem-highlight" d="M100 0 L100 100 L60 60 Z" fill=${cssVars.colors.artworkHighlight} />
        <path class="gem-shade" d="M0 100 L100 100 L60 60 Z" fill=${cssVars.colors.artworkShade} />

        <path class="gem-stroke" d="M85 85 L95 15 L15 95 Z" fill="none" stroke=${cssVars.colors.artworkStroke} stroke-width="1" />
      </svg>

      <div class="gem-glow" style=${`
        position: absolute;
        top: 10px;
        right: 0;
        bottom: 0;
        left: 10px;
        background: radial-gradient(circle at 80% 80%, ${cssVars.colors.artworkGlow}, transparent 70%);
        opacity: 0;
        pointer-events: none;
        mix-blend-mode: screen;
      `}></div>
    </div>
  `
})

function getLocales () {
  return {
    'Hide Toolbar': { en: 'Hide Toolbar', fr: 'Masquer la barre d’outils', it: 'Nascondi barra degli strumenti', de: 'Symbolleiste ausblenden', es: 'Ocultar barra de herramientas', 'pt-BR': 'Ocultar barra de ferramentas', ru: 'Скрыть панель инструментов', 'zh-CN': '隐藏工具栏', 'zh-TW': '隱藏工具列', ja: 'ツールバーを隠す', ko: '도구 모음 숨기기' },
    'App Store': { en: 'App Store', fr: 'Boutique d’applications', it: 'App Store', de: 'App-Store', es: 'Tienda de aplicaciones', 'pt-BR': 'Loja de apps', ru: 'Магазин приложений', 'zh-CN': '应用商店', 'zh-TW': '應用程式商店', ja: 'アプリストア', ko: '앱 스토어' },
    Settings: { en: 'Settings', fr: 'Paramètres', it: 'Impostazioni', de: 'Einstellungen', es: 'Configuración', 'pt-BR': 'Configurações', ru: 'Настройки', 'zh-CN': '设置', 'zh-TW': '設定', ja: '設定', ko: '설정' }
  }
}
