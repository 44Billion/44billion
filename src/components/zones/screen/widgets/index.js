import {
  f,
  useComputed,
  useGlobalStore,
  useGlobalSignal,
  useMemo,
  useStore,
  useTask
} from '#f'
import { useWebStorage } from '#f'
import { cssVars } from '#assets/styles/theme.js'
import { useActiveWorkspaceOrder } from '#hooks/use-active-workspace-order.js'
import { tell } from '#helpers/window-message/index.js'
import '#shared/pending-indicator.js'
import '#shared/icons/icon-close.js'
import { APP_PENDING_INDICATOR_DELAY_MS, initAppWindow } from '#helpers/window-message/app-bridge.js'
import { ensureAppBridgeState, registerAppBridgeWindow } from '#helpers/window-message/app-bridge-registry.js'
import { allocateAppSubdomain } from '#helpers/subdomain-mapping.js'
import { useVaultActor } from '#zones/vault-modal/index.js'
import { usePermissionDialogStore } from '#zones/permission-dialog/index.js'
import { useConfirmationDialogStore } from '#zones/confirmation-dialog/index.js'
import { getAssetBudgetConfirmation } from '#i18n/asset-budget.js'
import { formatAssetBudgetBytes } from '#services/app-asset-budget/index.js'
import { getT } from '#i18n/index.js'
import {
  addWidget,
  applyWidgetPositions,
  applyWidgetResize,
  BASE_CELL,
  computeEffectiveGrid,
  fitWidgets,
  removeWidget,
  readWidgetSessionValue,
  resizeWidgetFromNode,
  shouldApplyVirtualWidth,
  WIDGET_DEFAULT_DESIRED,
  WIDGET_AUTO_FIT_MIN_WIDTH,
  WIDGET_MINIMIZED_TTL_MS,
  writeWidgetSessionValue
} from '#services/widgets/index.js'

export const widgetsLocales = getLocales()
const t = getT(widgetsLocales)

const GAP = 20
const LONG_PRESS_MS = 600
const DOT_SIZE = 8
const DOT_GAP = 8
const DRAG_EDGE_ZONE = 48
const DRAG_PAGE_FLIP_DELAY_MS = 450
const DRAG_PAGE_FLIP_THROTTLE_MS = 1500
const WIDGET_FRESH_WINDOW_MS = 10000
const WIDGET_SELECTED_WINDOW_MS = 4000

// Temporary widget-drag instrumentation: only log in development builds.
const widgetDragLog = (...args) => {
  if (IS_DEVELOPMENT) console.log(...args)
}

function computeGridSize (el) {
  return computeEffectiveGrid(el?.clientWidth ?? 0, el?.clientHeight ?? 0)
}

function placementStyle (placement, grid) {
  if (!placement || !grid) return null
  // `col` is absolute across pages; the grid width and page step keep each
  // page aligned, so no modulo is applied here.
  const cell = grid.cell || BASE_CELL
  const gap = grid.gap || GAP
  const margin = grid.margin || GAP
  return `left:${margin + placement.col * (cell + gap)}px;` +
    `top:${margin + placement.row * (cell + gap)}px;` +
    `width:${placement.w * cell + (placement.w - 1) * gap}px;` +
    `height:${placement.h * cell + (placement.h - 1) * gap}px;`
}

f('widgets-layer', function () {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const { order$ } = useActiveWorkspaceOrder(storage, tabStorage)
  const createRequest$ = useGlobalSignal('widgetsCreateRequest', null)
  const dragDraft$ = useGlobalSignal('widgetDragDraft', null)
  const dragEdge$ = useGlobalSignal('widgetDragEdge', null)
  const widgetFresh$ = useGlobalSignal('widgetFresh', null)
  const store = useStore(() => ({
    elRef$: null,
    scrollRef$: null,
    dotsRef$: null,
    grid$: {
      cols: 1,
      rows: 1,
      cell: BASE_CELL,
      gap: GAP,
      margin: GAP,
      scale: 1,
      pageWidth: 0,
      pageHeight: 0,
      viewportWidth: 0,
      viewportHeight: 0
    },
    currentPage$: 0,
    dotsWidth$: 0
  }))

  useTask(({ track, cleanup }) => {
    const el = track(() => store.scrollRef$())
    if (!el) return
    const update = () => store.grid$(computeGridSize(el))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    cleanup(() => observer.disconnect())
  }, { after: 'rendering' })

  useTask(({ track, cleanup }) => {
    const el = track(() => store.dotsRef$())
    if (!el) return
    const update = () => store.dotsWidth$(el.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    cleanup(() => observer.disconnect())
  }, { after: 'rendering' })

  useTask(({ track, cleanup }) => {
    const el = track(() => store.scrollRef$())
    if (!el) return
    const update = () => {
      const step = store.grid$().pageWidth + store.grid$().gap
      if (step <= 0) return
      store.currentPage$(Math.round(el.scrollLeft / step))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    cleanup(() => el.removeEventListener('scroll', update))
  })

  // Real-widget creation: resolve the menu request on the current page.
  useTask(({ track }) => {
    const request = track(() => createRequest$())
    if (!request) return
    const grid = store.grid$()
    const page = store.currentPage$()
    const col = Math.max(0, page * grid.cols)
    const widgetKey = addWidget({
      localStorageArea: localStorage,
      appId: request.appId,
      wsKey: request.wsKey,
      row: 0,
      col,
      desired: WIDGET_DEFAULT_DESIRED,
      pinnedRoute: request.pinnedRoute || ''
    })
    writeWidgetSessionValue(sessionStorage, widgetKey, 'route', request.pinnedRoute || '')
    writeWidgetSessionValue(sessionStorage, widgetKey, 'visibility', 'open')
    widgetFresh$({ widgetKey, until: Date.now() + WIDGET_FRESH_WINDOW_MS })
    createRequest$(null)
  })

  const activeWsKey$ = useComputed(() => order$()[0] ?? null)
  const wsWidgets$ = useComputed(() => {
    const wsKey = activeWsKey$()
    const widgets = storage.local_widgets$() ?? {}
    if (!wsKey) return []
    return Object.entries(widgets)
      .filter(([, widget]) => widget?.wsKey === wsKey)
      .map(([widgetKey, widget]) => ({ ...widget, widgetKey }))
  })
  const layout$ = useComputed(() => {
    const grid = store.grid$()
    const widgets = wsWidgets$()
    if (widgets.length === 0) return { placements: [], pageCount: 1 }
    const drag = dragDraft$()
    const entries = drag?.widgetKey
      ? widgets.map(widget =>
        widget.widgetKey === drag.widgetKey
          ? {
              ...widget,
              row: drag.row,
              col: drag.col,
              ...(drag.desired ? { desired: drag.desired } : {})
            }
          : widget
      )
      : widgets
    return fitWidgets(entries, {
      viewportCols: grid.cols,
      viewportRows: grid.rows,
      anchorKey: drag?.widgetKey ?? null
    })
  })
  const placementsByKey$ = useComputed(() => {
    const map = {}
    for (const placement of layout$().placements) map[placement.widgetKey] = placement
    return map
  })
  const pageCount$ = useComputed(() => layout$().pageCount)
  const pageStep$ = useComputed(() =>
    Math.max(store.grid$().pageWidth + store.grid$().gap, 1)
  )
  const maxDots$ = useComputed(() =>
    Math.max(1, Math.floor((store.dotsWidth$() + DOT_GAP) / (DOT_SIZE + DOT_GAP)))
  )
  const visiblePages$ = useComputed(() => {
    const total = Math.max(1, pageCount$())
    const current = Math.min(Math.max(0, store.currentPage$()), total - 1)
    const max = maxDots$()
    if (total <= max) return Array.from({ length: total }, (_, index) => index)
    const half = Math.floor((max - 1) / 2)
    const start = Math.max(0, Math.min(current - half, total - max))
    return Array.from({ length: max }, (_, index) => start + index)
  })
  const widgetKeys$ = useComputed(() => {
    const wsKey = activeWsKey$()
    const widgets = storage.local_widgets$() ?? {}
    if (!wsKey) return []
    return Object.keys(widgets).filter(key => widgets[key]?.wsKey === wsKey)
  })
  const grid = store.grid$()
  const pageWidth = Math.max(grid.pageWidth, 1)
  const pageCount = Math.max(1, pageCount$())
  const pageStep = pageWidth + grid.gap
  const contentWidth = pageCount * pageWidth + (pageCount + 1) * grid.margin
  // Keep enough trailing space so every page (including the last) can align
  // its left margin to the viewport edge instead of being clamped mid-page.
  const gridWidth = Math.max(
    contentWidth,
    (grid.viewportWidth || 0) + (pageCount - 1) * pageStep
  )
  const goToPage = page => {
    const el = store.scrollRef$()
    if (!el) return
    el.scrollTo({
      left: Math.max(0, Math.min(page, pageCount - 1)) * pageStep$(),
      behavior: 'smooth'
    })
  }
  const swipe = useMemo(() => ({ startX: null, suppressClick: false }))
  const onDotsPointerDown = event => {
    swipe.startX = event.clientX
    swipe.suppressClick = false
  }
  const onDotsPointerUp = event => {
    if (swipe.startX == null) return
    const dx = event.clientX - swipe.startX
    swipe.startX = null
    if (Math.abs(dx) < 40) return
    swipe.suppressClick = true
    goToPage(store.currentPage$() + (dx < 0 ? 1 : -1))
  }
  const onDotClick = page => {
    if (swipe.suppressClick) {
      swipe.suppressClick = false
      return
    }
    goToPage(page)
  }

  return this.h`
    <div id='widgets-layer' ref=${store.elRef$} class='widgets-layer-scope'>
      <style>${/* css */`
        .widgets-layer-scope#widgets-layer {
          position: absolute;
          inset: 0;
          z-index: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          pointer-events: none;
        }
        .widgets-layer-scope#widgets-layer #widgets-scroll {
          flex: 1;
          min-height: 0;
          position: relative;
          overflow-x: auto;
          overflow-y: hidden;
          pointer-events: none;
          scrollbar-width: none;
        }
        .widgets-layer-scope#widgets-layer #widgets-scroll::-webkit-scrollbar {
          display: none;
        }
        .widgets-layer-scope#widgets-layer #widgets-grid {
          position: relative;
          height: 100%;
          width: ${gridWidth}px;
          pointer-events: none;
        }
        .widgets-layer-scope#widgets-layer widget-window {
          pointer-events: auto;
        }
        .widgets-layer-scope#widgets-layer #widgets-dots {
          flex: 0 0 ${GAP}px;
          height: ${GAP}px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: ${DOT_GAP}px;
          pointer-events: auto;
          touch-action: pan-y;
        }
        .widgets-layer-scope#widgets-layer .widget-page-dot {
          width: ${DOT_SIZE}px;
          height: ${DOT_SIZE}px;
          border: 0;
          padding: 0;
          border-radius: 50%;
          cursor: pointer;
          background-color: ${cssVars.colors.fg3};
          opacity: .55;
        }
        .widgets-layer-scope#widgets-layer .widget-page-dot.active {
          background-color: ${cssVars.colors.bgAccentPrimary};
          opacity: 1;
        }
        .widgets-layer-scope#widgets-layer .widget-edge-gradient {
          position: absolute;
          top: 0;
          bottom: 0;
          width: ${DRAG_EDGE_ZONE}px;
          pointer-events: none;
          z-index: 2000;
          opacity: 0;
          transition: opacity .15s ease;
        }
        .widgets-layer-scope#widgets-layer .widget-edge-gradient.left {
          left: 0;
          background: linear-gradient(
            to right,
            color-mix(in srgb, ${cssVars.colors.bgAccentPrimary} 55%, transparent),
            transparent
          );
        }
        .widgets-layer-scope#widgets-layer .widget-edge-gradient.right {
          right: 0;
          background: linear-gradient(
            to left,
            color-mix(in srgb, ${cssVars.colors.bgAccentPrimary} 55%, transparent),
            transparent
          );
        }
        .widgets-layer-scope#widgets-layer .widget-edge-gradient.visible {
          opacity: 1;
        }
      `}</style>
      <div
        class=${{
          'widget-edge-gradient': true,
          left: true,
          visible: dragEdge$() === 'left'
        }}
      ></div>
      <div
        class=${{
          'widget-edge-gradient': true,
          right: true,
          visible: dragEdge$() === 'right'
        }}
      ></div>
      <div id='widgets-scroll' ref=${store.scrollRef$}>
        <div id='widgets-grid'>
          <div style="display: contents"></div>
          ${widgetKeys$().map(key => this.h({ key })`
            <widget-window
              props=${{
                widgetKey: key,
                layout$: placementsByKey$,
                grid$: store.grid$
              }}
            />
          `)}
        </div>
      </div>
      <div
        id='widgets-dots'
        ref=${store.dotsRef$}
        onpointerdown=${onDotsPointerDown}
        onpointerup=${onDotsPointerUp}
      >
        <div style="display: contents"></div>
        ${(pageCount > 1 ? visiblePages$() : []).map(page => this.h({ key: page })`
          <button
            class=${{
              'widget-page-dot': true,
              active: page === store.currentPage$()
            }}
            aria-label=${`Page ${page + 1}`}
            onclick=${() => onDotClick(page)}
          ></button>
        `)}
      </div>
    </div>
  `
})

f('widget-window', function () {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const widgetKey = this.props.widgetKey
  const layout$ = this.props.layout$
  const grid$ = this.props.grid$
  const dragDraft$ = useGlobalSignal('widgetDragDraft', null)
  const dragEdge$ = useGlobalSignal('widgetDragEdge', null)
  const widgetFresh$ = useGlobalSignal('widgetFresh', null)
  const { askVault } = useVaultActor()
  const { requestPermission } = usePermissionDialogStore()
  const { requestConfirmation } = useConfirmationDialogStore()
  const { openApp } = useGlobalStore('useAppRouter')

  const store = useStore(() => ({
    record$ () {
      return storage.local_widgets$()?.[widgetKey] ?? null
    },
    visibility$ () {
      return tabStorage[`session_widgetByKey_${widgetKey}_visibility$`]() ?? 'closed'
    },
    route$ () {
      return tabStorage[`session_widgetByKey_${widgetKey}_route$`]() ?? ''
    },
    inView$: false,
    minimizedAt$: null,
    selected$: false,
    freshUntil$: 0,
    dragging$: false,
    elRef$: null,
    appIframeRef$: null,
    appIframeSrc$: 'about:blank',
    appReady$: false,
    showPending$: false,
    launchError$: null,
    wideMode$: false,
    minWidth$: WIDGET_AUTO_FIT_MIN_WIDTH
  }))

  const runtime = useMemo(() => ({
    startedGeneration: null,
    appReady: false,
    autoRetried: false,
    appCleanup: null,
    routeVersion: 0,
    loadedRouteVersion: -1,
    bridgeState: null,
    ac: null,
    unregister: null,
    selectionTimer: null,
    freshTimer: null
  }))

  const placement$ = useComputed(() => layout$()[widgetKey] ?? null)
  const cellWidth$ = useComputed(() => {
    const placement = placement$()
    if (!placement) return null
    const grid = grid$()
    return placement.w * (grid.cell + grid.gap) - grid.gap
  })
  const appSubdomain$ = useComputed(() => {
    const record = store.record$()
    if (!record) return null
    const userPk = storage[`session_workspaceByKey_${record.wsKey}_userPk$`]()
    if (!userPk || !record.appId) return null
    return storage[`session_subdomainByUserAndApp_${userPk}_${record.appId}$`]()
  })

  const syncSelectMode = () => {
    const enabled = store.selected$() || store.freshUntil$() > Date.now()
    const port = runtime.bridgeState?.windows.get(widgetKey)?.widgetPort
    widgetDragLog('[widget-drag] select-mode', {
      enabled,
      widgetKey,
      hasPort: !!port
    })
    if (port) tell(port, { code: 'WIDGET_SELECT_MODE', payload: { enabled } })
  }
  const deselect = () => {
    clearTimeout(runtime.selectionTimer)
    runtime.selectionTimer = null
    if (store.selected$()) {
      store.selected$(false)
      syncSelectMode()
    }
  }
  const startSelectionTimer = () => {
    clearTimeout(runtime.selectionTimer)
    store.selected$(true)
    // The first interaction ends the fresh (post-creation) window: once the
    // solid selection border takes over, the animated border must not come
    // back when selection expires or is dismissed.
    clearTimeout(runtime.freshTimer)
    runtime.freshTimer = null
    if (store.freshUntil$() > 0) {
      store.freshUntil$(0)
      widgetFresh$(null)
    }
    syncSelectMode()
    runtime.selectionTimer = setTimeout(() => {
      runtime.selectionTimer = null
      store.selected$(false)
      syncSelectMode()
    }, WIDGET_SELECTED_WINDOW_MS)
  }

  // The injected app-page listener reports pointer coordinates relative to
  // the iframe's own viewport, which moves together with the widget. Convert
  // them to viewport coordinates using the iframe's current bounding rect
  // (including the wide-mode transform scale) so drag math is stable while
  // the widget itself is being moved.
  const toViewportPoint = (x, y) => {
    const iframeEl = store.appIframeRef$()
    if (!iframeEl) return { x, y }
    const rect = iframeEl.getBoundingClientRect()
    const scaleX = rect.width > 0 && iframeEl.offsetWidth > 0
      ? rect.width / iframeEl.offsetWidth
      : 1
    const scaleY = rect.height > 0 && iframeEl.offsetHeight > 0
      ? rect.height / iframeEl.offsetHeight
      : 1
    return {
      x: rect.left + x * scaleX,
      y: rect.top + y * scaleY
    }
  }

  // Track the fresh (post-creation) window from the layer.
  useTask(({ track, cleanup }) => {
    const fresh = track(() => widgetFresh$())
    const until = fresh?.widgetKey === widgetKey ? Number(fresh.until) || 0 : 0
    clearTimeout(runtime.freshTimer)
    runtime.freshTimer = null
    store.freshUntil$(until)
    if (until > Date.now()) {
      runtime.freshTimer = setTimeout(() => {
        runtime.freshTimer = null
        store.freshUntil$(0)
        syncSelectMode()
      }, until - Date.now())
    }
    syncSelectMode()
    cleanup(() => clearTimeout(runtime.freshTimer))
  })

  // Deselect when another widget starts dragging.
  useTask(({ track }) => {
    const draft = track(() => dragDraft$())
    if (draft?.widgetKey && draft.widgetKey !== widgetKey && store.selected$()) {
      deselect()
    }
  })

  // Deselect on Escape or a launcher-side click outside the widget.
  useTask(({ cleanup }) => {
    const onPointerDown = event => {
      if (!store.selected$()) return
      const root = store.elRef$()
      if (root && root.contains(event.target)) return
      deselect()
    }
    const onKeyDown = event => {
      if (event.key === 'Escape') deselect()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    cleanup(() => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    })
  })

  // Apply/re-evaluate the virtual width whenever the cell width or the app's
  // minWidth changes. The app page re-measures on its own viewport changes
  // and covers zoom switches with its view transition; scale-only changes in
  // wide mode need no re-measure at all, so the iframe must never be hidden
  // here (that would also hide the app page's transition snapshot).
  const reeval = useMemo(() => ({ lastCellWidth: null, lastMinWidth: null }))
  useTask(({ track }) => {
    const cellWidth = track(() => cellWidth$())
    const minWidth = track(() => store.minWidth$())
    if (cellWidth == null) return
    const applyWide = shouldApplyVirtualWidth(cellWidth, minWidth)
    const cellChanged = reeval.lastCellWidth !== null && cellWidth !== reeval.lastCellWidth
    const minWidthChanged = reeval.lastMinWidth !== null && minWidth !== reeval.lastMinWidth
    reeval.lastCellWidth = cellWidth
    reeval.lastMinWidth = minWidth
    const modeChanged = store.wideMode$() !== applyWide
    if (!cellChanged && !minWidthChanged && !modeChanged) return
    store.wideMode$(applyWide)
  })

  const setVisibility = (visibility, { now = Date.now() } = {}) => {
    writeWidgetSessionValue(sessionStorage, widgetKey, 'visibility', visibility)
    if (visibility === 'open') {
      store.minimizedAt$(null)
      const record = store.record$()
      if (!readWidgetSessionValue(sessionStorage, widgetKey, 'route') && record?.pinnedRoute) {
        writeWidgetSessionValue(sessionStorage, widgetKey, 'route', record.pinnedRoute)
      }
    }
    if (visibility === 'minimized') store.minimizedAt$(now)
    if (visibility === 'closed') store.minimizedAt$(null)
  }

  // Track whether the widget cell is inside the useful viewport.
  useTask(({ track, cleanup }) => {
    const el = track(() => store.elRef$())
    const layer = el?.closest?.('#widgets-layer')
    if (!el || !layer) return
    const observer = new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1]
      store.inView$(entry.isIntersecting)
    }, { root: layer, rootMargin: '0px', threshold: 0.05 })
    observer.observe(el)
    cleanup(() => observer.disconnect())
  }, { after: 'rendering' })

  // Close/minimize automatically when the tab is hidden.
  useTask(({ cleanup }) => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && store.visibility$() === 'open') {
        setVisibility('minimized')
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    cleanup(() => document.removeEventListener('visibilitychange', onVisibility))
  })

  // Lifecycle: closed+inView -> open; open+out -> minimized; minimized 5min -> closed.
  useTask(({ track, cleanup }) => {
    const visibility = track(() => store.visibility$())
    const inView = track(() => store.inView$())
    const record = track(() => store.record$())
    if (!record) return

    if (document.visibilityState === 'hidden' && visibility === 'open') {
      setVisibility('minimized')
      return
    }
    if (inView && visibility === 'closed') {
      setVisibility('open')
      return
    }
    if (!inView && visibility === 'open') {
      setVisibility('minimized')
      return
    }
    if (visibility === 'minimized' && store.minimizedAt$()) {
      const timer = setTimeout(() => {
        if (store.visibility$() !== 'minimized') return
        writeWidgetSessionValue(sessionStorage, widgetKey, 'route', record.pinnedRoute || '')
        setVisibility('closed')
      }, WIDGET_MINIMIZED_TTL_MS)
      cleanup(() => clearTimeout(timer))
    }
  })

  // Load/unload the app iframe.
  useTask(
    async ({ track, cleanup }) => {
      const isClosed = track(() => store.visibility$() === 'closed')
      const appId = track(() => store.record$()?.appId)
      const wsKey = track(() => store.record$()?.wsKey)
      const iframeRef = track(() => store.appIframeRef$())
      const appSubdomain = track(() => appSubdomain$())
      if (!appId || !wsKey) return
      const userPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
      const pinnedRoute = store.record$()?.pinnedRoute ?? ''
      const route = readWidgetSessionValue(sessionStorage, widgetKey, 'route') ?? pinnedRoute
      store.launchError$(null)

      if (isClosed || !appId || !userPk) {
        store.appIframeSrc$('about:blank')
        store.appIframeRef$(null)
        store.appReady$(false)
        store.showPending$(false)
        store.wideMode$(false)
        store.minWidth$(WIDGET_AUTO_FIT_MIN_WIDTH)
        runtime.ac?.abort()
        runtime.unregister?.()
        runtime.appCleanup?.()
        runtime.ac = null
        runtime.unregister = null
        runtime.appCleanup = null
        runtime.startedGeneration = null
        runtime.appReady = false
        runtime.routeVersion++
        runtime.loadedRouteVersion = -1
        return
      }
      if (!iframeRef) return
      if (!appSubdomain) {
        allocateAppSubdomain(storage, { userPk, appId })
        return
      }

      // Once the app page window port is live, never tear it down on bridge
      // re-runs (retries/toggles): a new port would require the app page to
      // re-handshake, which it only does once per load.
      if (runtime.appCleanup && runtime.appReady) return

      if (!runtime.ac || !runtime.bridgeState || !runtime.unregister) {
        runtime.ac = new AbortController()
        runtime.bridgeState = ensureAppBridgeState(appSubdomain, { userPk, appId })
        syncSelectMode()
        runtime.unregister = registerAppBridgeWindow(runtime.bridgeState, {
          appKey: widgetKey,
          onClose () {
            if (store.visibility$() === 'open') setVisibility('minimized')
          },
          onWidgetDrag ({ op, x, y, screenX, screenY }) {
            const hasScreen = Number.isFinite(screenX) && Number.isFinite(screenY)
            if (op === 'start') {
              const point = toViewportPoint(x, y)
              drag.screenOffsetX = hasScreen ? point.x - screenX : 0
              drag.screenOffsetY = hasScreen ? point.y - screenY : 0
              widgetDragLog('[widget-drag] launcher onWidgetDrag', {
                op,
                x,
                y,
                screenX,
                screenY,
                viewportX: point.x,
                viewportY: point.y,
                widgetKey,
                hasPlacement: !!placement$(),
                dragActive: drag.active
              })
              beginDragFromPointer(point.x, point.y)
              return
            }
            const point = hasScreen
              ? { x: screenX + drag.screenOffsetX, y: screenY + drag.screenOffsetY }
              : toViewportPoint(x, y)
            widgetDragLog('[widget-drag] launcher onWidgetDrag', {
              op,
              x,
              y,
              screenX,
              screenY,
              viewportX: point.x,
              viewportY: point.y,
              widgetKey,
              hasPlacement: !!placement$(),
              dragActive: drag.active
            })
            if (op === 'move') moveDragFromPointer(point.x, point.y)
            else if (op === 'end') endDragFromPointer()
          },
          onSetMinWidth (minWidth) {
            const value = Math.round(Number(minWidth))
            if (!Number.isFinite(value) || value < 0) {
              console.warn('[widget-window] Invalid minWidth', minWidth)
              return
            }
            store.minWidth$(value)
          }
        })
      }
      const bridgeState = runtime.bridgeState
      const ac = runtime.ac
      const [bridgeReady, bridgeError] = track(() => [
        bridgeState.ready$(),
        bridgeState.error$()
      ])
      if (bridgeError) {
        store.showPending$(false)
        store.launchError$('Failed to load widget')
        runtime.startedGeneration = null
        runtime.appReady = false
        store.appReady$(false)
        return
      }
      if (!bridgeReady) {
        let pendingTimer = null
        const schedulePending = () => {
          clearTimeout(pendingTimer)
          store.showPending$(false)
          pendingTimer = setTimeout(() => {
            if (ac.signal.aborted || bridgeReady || runtime.appReady) return
            store.showPending$(true)
          }, APP_PENDING_INDICATOR_DELAY_MS)
        }
        cleanup(() => clearTimeout(pendingTimer))
        schedulePending()
        runtime.startedGeneration = null
        runtime.appReady = false
        store.appReady$(false)
        return
      }
      if (runtime.appCleanup && runtime.appReady) return

      runtime.appCleanup?.()
      runtime.appCleanup = null
      runtime.appReady = false
      store.appReady$(false)
      store.launchError$(null)

      const onAppReady = () => {
        store.showPending$(false)
        runtime.appReady = true
        store.appReady$(true)
        syncSelectMode()
      }
      runtime.loadedRouteVersion = runtime.routeVersion
      const cleanupApp = initAppWindow(bridgeState, {
        appKey: widgetKey,
        wsKey,
        instanceKind: 'widget',
        initialRoute: route,
        appIframeRef$: store.appIframeRef$,
        appIframeSrc$: store.appIframeSrc$,
        askVault,
        requestPermission,
        openApp,
        onFileNotCached: details => bridgeState.bridgeErrorHandler?.(details),
        requestAssetBudgetConfirmation: details => requestConfirmation(getAssetBudgetConfirmation({
          ...details,
          formatBytes: formatAssetBudgetBytes
        })),
        onAppReady,
        signal: ac.signal
      })
      runtime.appCleanup = cleanupApp
    },
    { after: 'rendering' }
  )

  // Unmount-only teardown for the manually managed bridge lifecycle (the
  // iframe task above intentionally does not register these with its own
  // cleanup, so bridge re-runs never close the live window port).
  useTask(({ cleanup }) => {
    cleanup(() => {
      runtime.ac?.abort()
      runtime.unregister?.()
      runtime.appCleanup?.()
      runtime.ac = null
      runtime.unregister = null
      runtime.appCleanup = null
      runtime.bridgeState = null
    })
  })

  // Closed widgets have no iframe, so the root itself can detect long-press.
  const longPressTimer = useMemo(() => ({ id: null }))
  const onClosedPointerDown = event => {
    if (store.visibility$() !== 'closed') return
    clearTimeout(longPressTimer.id)
    longPressTimer.id = setTimeout(() => {
      beginDragFromPointer(event.clientX, event.clientY)
      window.addEventListener('pointermove', onClosedPointerMove, { capture: true })
      window.addEventListener('pointerup', onClosedPointerEnd, { capture: true })
    }, LONG_PRESS_MS)
  }
  const onClosedPointerMove = event => {
    if (drag.active) moveDragFromPointer(event.clientX, event.clientY)
  }
  const onClosedPointerEnd = _event => {
    clearTimeout(longPressTimer.id)
    window.removeEventListener('pointermove', onClosedPointerMove, { capture: true })
    window.removeEventListener('pointerup', onClosedPointerEnd, { capture: true })
    if (drag.active) endDragFromPointer()
  }

  const removeWidgetNow = () => {
    const record = store.record$()
    if (!record) return
    removeWidget({
      localStorageArea: localStorage,
      sessionStorageArea: sessionStorage,
      widgetKey
    })
  }

  // Drag to move the widget.
  const drag = useMemo(() => ({
    active: false,
    startX: 0,
    startY: 0,
    startRow: 0,
    startCol: 0,
    screenOffsetX: 0,
    screenOffsetY: 0,
    lastClientX: 0,
    flipTimer: null,
    flipDir: 0,
    lastFlipAt: 0
  }))
  const stopDragAutoFlip = () => {
    clearTimeout(drag.flipTimer)
    drag.flipTimer = null
    drag.flipDir = 0
    dragEdge$(null)
  }
  const scheduleDragAutoFlip = (scrollEl, dir) => {
    if (drag.flipDir === dir && drag.flipTimer) return
    drag.flipDir = dir
    clearTimeout(drag.flipTimer)
    const flipPage = () => {
      drag.flipTimer = null
      const elapsed = Date.now() - drag.lastFlipAt
      if (elapsed < DRAG_PAGE_FLIP_THROTTLE_MS) {
        if (drag.flipDir === dir) {
          drag.flipTimer = setTimeout(flipPage, DRAG_PAGE_FLIP_THROTTLE_MS - elapsed)
        }
        return
      }
      const grid = grid$()
      if (!grid || !scrollEl.isConnected) return
      const step = grid.pageWidth + grid.gap
      const current = Math.round(scrollEl.scrollLeft / step)
      // Allow creating new pages to the right while dragging; only the first
      // page bounds the left direction.
      const next = Math.max(0, current + dir)
      if (next === current) return
      drag.lastFlipAt = Date.now()
      drag.startCol += dir * grid.cols
      dragDraft$(draft => draft
        ? { ...draft, col: draft.col + dir * grid.cols }
        : draft)
      // Wait two frames so the layer re-renders the (possibly grown) grid
      // width before scrolling; otherwise the browser clamps scrollLeft to the
      // old width and the page never moves. Retry once if it still clamped.
      const scrollToPageAfterRender = () => {
        if (!scrollEl.isConnected) return
        scrollEl.scrollTo({ left: next * step, behavior: 'smooth' })
        requestAnimationFrame(() => {
          if (!scrollEl.isConnected) return
          if (Math.round(scrollEl.scrollLeft / step) < next) {
            scrollEl.scrollTo({ left: next * step, behavior: 'smooth' })
          }
        })
      }
      requestAnimationFrame(() => requestAnimationFrame(scrollToPageAfterRender))
      const rect = scrollEl.getBoundingClientRect()
      const stillInZone = dir > 0
        ? drag.lastClientX >= rect.right - DRAG_EDGE_ZONE
        : drag.lastClientX <= rect.left + DRAG_EDGE_ZONE
      if (stillInZone) scheduleDragAutoFlip(scrollEl, dir)
    }
    drag.flipTimer = setTimeout(flipPage, DRAG_PAGE_FLIP_DELAY_MS)
  }
  const beginDragFromPointer = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      console.warn('[widget-drag] begin skipped: non-finite pointer', { x, y, widgetKey })
      return
    }
    if (drag.active) {
      widgetDragLog('[widget-drag] begin skipped: already active', { widgetKey })
      return
    }
    const placement = placement$()
    if (!placement) {
      widgetDragLog('[widget-drag] begin skipped: no placement', { widgetKey })
      return
    }
    drag.active = true
    drag.startX = x
    drag.startY = y
    drag.startRow = placement.row
    drag.startCol = placement.col
    clearTimeout(runtime.selectionTimer)
    dragDraft$({
      widgetKey,
      col: placement.col,
      row: placement.row,
      desired: { w: placement.w, h: placement.h }
    })
    store.dragging$(true)
  }
  const moveDragFromPointer = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      console.warn('[widget-drag] move skipped: non-finite pointer', { x, y, widgetKey })
      return
    }
    if (!drag.active) return
    const grid = grid$()
    const size = placement$()
    if (!size || !grid) return
    const cell = grid.cell + grid.gap
    let row = drag.startRow + Math.round((y - drag.startY) / cell)
    let col = drag.startCol + Math.round((x - drag.startX) / cell)
    row = Math.max(0, Math.min(row, grid.rows - size.h))
    // Confine the pointer movement to the widget's current draft page; page
    // changes are handled exclusively by the auto-flip (which shifts the draft
    // column by ±cols together with the smooth scroll).
    const currentDraft = dragDraft$()
    const currentPage = Math.max(
      0,
      Math.floor((currentDraft?.col ?? drag.startCol) / grid.cols)
    )
    const minCol = currentPage * grid.cols
    const maxCol = currentPage * grid.cols + Math.max(0, grid.cols - size.w)
    col = Math.max(minCol, Math.min(col, maxCol))
    dragDraft$(draft => draft
      ? {
          ...draft,
          col,
          row
        }
      : draft)
    const scrollEl = store.elRef$()?.closest?.('#widgets-scroll')
    if (!scrollEl) return
    drag.lastClientX = x
    const rect = scrollEl.getBoundingClientRect()
    const dir = x >= rect.right - DRAG_EDGE_ZONE
      ? 1
      : x <= rect.left + DRAG_EDGE_ZONE
        ? -1
        : 0
    if (dir !== 0) {
      const step = grid.pageWidth + grid.gap
      const current = Math.round(scrollEl.scrollLeft / step)
      dragEdge$(dir === 1 ? 'right' : current > 0 ? 'left' : null)
      scheduleDragAutoFlip(scrollEl, dir)
    } else {
      dragEdge$(null)
      stopDragAutoFlip()
    }
  }
  const endDragFromPointer = () => {
    if (!drag.active) return
    drag.active = false
    stopDragAutoFlip()
    const preview = dragDraft$()
    store.dragging$(false)
    dragDraft$(null)
    if (!preview) return
    const grid = grid$()
    if (!grid) return
    const record = store.record$()
    if (!record) return
    const allWidgets = Object.entries(storage.local_widgets$() ?? {})
      .filter(([, widget]) => widget?.wsKey === record.wsKey)
      .map(([otherKey, widget]) => ({ ...widget, widgetKey: otherKey }))
    const entries = allWidgets.map(widget =>
      widget.widgetKey === widgetKey
        ? { ...widget, row: preview.row, col: preview.col }
        : widget
    )
    const fitted = fitWidgets(entries, {
      viewportCols: grid.cols,
      viewportRows: grid.rows,
      anchorKey: widgetKey
    })
    applyWidgetPositions({
      localStorageArea: localStorage,
      positions: fitted.placements.map(position => ({
        widgetKey: position.widgetKey,
        row: position.row,
        col: position.col
      }))
    })
    startSelectionTimer()
  }

  // Resize via the four edge nodes (shown while selected).
  const resize = useMemo(() => ({
    active: false,
    node: null,
    nodeEl: null,
    pointerId: null,
    startX: 0,
    startY: 0,
    startRow: 0,
    startCol: 0,
    startW: 1,
    startH: 1
  }))
  const beginResize = (node, event) => {
    if (resize.active || !store.selected$()) return
    const record = store.record$()
    if (!record) return
    event.preventDefault()
    event.stopPropagation()
    const root = store.elRef$()
    resize.active = true
    resize.node = node
    resize.nodeEl = root
    resize.pointerId = event.pointerId
    resize.startX = event.clientX
    resize.startY = event.clientY
    resize.startRow = record.row
    resize.startCol = record.col
    resize.startW = Math.max(1, Math.floor(Number(record.desired?.w) || 1))
    resize.startH = Math.max(1, Math.floor(Number(record.desired?.h) || 1))
    clearTimeout(runtime.selectionTimer)
    try {
      if (root?.setPointerCapture) root.setPointerCapture(event.pointerId)
    } catch (error) {
      console.warn('[widget-window] Failed to capture pointer for resize', error)
    }
    window.addEventListener('pointermove', onResizeMove, { capture: true })
    window.addEventListener('pointerup', onResizeEnd, { capture: true })
    window.addEventListener('pointercancel', onResizeEnd, { capture: true })
  }
  const onResizeMove = event => {
    if (!resize.active) return
    const grid = grid$()
    if (!grid) return
    const cell = grid.cell + grid.gap
    const result = resizeWidgetFromNode({
      widget: {
        row: resize.startRow,
        col: resize.startCol,
        desired: { w: resize.startW, h: resize.startH }
      },
      node: resize.node,
      deltaCols: (event.clientX - resize.startX) / cell,
      deltaRows: (event.clientY - resize.startY) / cell,
      viewportCols: grid.cols,
      viewportRows: grid.rows
    })
    dragDraft$({
      widgetKey,
      row: result.row,
      col: result.col,
      desired: result.desired
    })
  }
  const onResizeEnd = () => {
    if (!resize.active) return
    resize.active = false
    window.removeEventListener('pointermove', onResizeMove, { capture: true })
    window.removeEventListener('pointerup', onResizeEnd, { capture: true })
    window.removeEventListener('pointercancel', onResizeEnd, { capture: true })
    try {
      if (resize.nodeEl?.hasPointerCapture?.(resize.pointerId)) {
        resize.nodeEl.releasePointerCapture(resize.pointerId)
      }
    } catch (error) {
      console.warn('[widget-window] Failed to release pointer capture', error)
    }
    resize.nodeEl = null
    resize.pointerId = null
    const preview = dragDraft$()
    if (preview?.widgetKey === widgetKey) {
      applyWidgetResize({
        localStorageArea: localStorage,
        widgetKey,
        row: preview.row,
        col: preview.col,
        desired: preview.desired
      })
    }
    dragDraft$(null)
    startSelectionTimer()
  }

  const record = store.record$()
  if (!record) return
  const placement = placement$()
  const style = placementStyle(placement, grid$())
  if (!style) return
  const visibility = store.visibility$()
  const isClosed = visibility === 'closed'
  const wide = store.wideMode$() && placement?.w && placement?.h
  const gridForStyle = grid$()
  const cellWidth = placement.w * (gridForStyle.cell + gridForStyle.gap) - gridForStyle.gap
  const cellHeight = placement.h * (gridForStyle.cell + gridForStyle.gap) - gridForStyle.gap
  const virtualWidth = store.minWidth$()
  const iframeStyle = wide && cellWidth > 0 && virtualWidth > 0
    ? `position:absolute;top:0;left:0;width:${virtualWidth}px;` +
      `height:${Math.round(cellHeight * virtualWidth / cellWidth)}px;` +
      `transform:scale(${cellWidth / virtualWidth});` +
      'transform-origin:top left;'
    : ''
  const isFresh = store.freshUntil$() > Date.now()
  const showSolidBorder = store.selected$() || store.dragging$()
  const showNodes = store.selected$() && !store.dragging$()

  return this.h`
    <div
      class=${{
        'widget-window-root': true,
        'widget-window-open': visibility === 'open',
        'widget-window-minimized': visibility === 'minimized',
        'widget-window-closed': isClosed,
        'widget-window-selected': showSolidBorder,
        'widget-window-fresh': isFresh && !showSolidBorder
      }}
      style=${store.dragging$() ? `${style}z-index:1000;` : style}
      ref=${store.elRef$}
      onpointerdown=${onClosedPointerDown}
    >
      <style>${/* css */`
        .widget-window-root {
          position: absolute;
          box-sizing: border-box;
          overflow: hidden;
          cursor: default;
        }
        .widget-window-root.widget-window-closed {
          border: 1px dashed ${cssVars.colors.fg3};
        }
        .widget-window-root.widget-window-selected {
          overflow: visible;
        }
        .widget-window-root.widget-window-selected::before {
          content: '';
          position: absolute;
          inset: 0;
          border: 2px solid ${cssVars.colors.bgAccentPrimary};
          border-radius: 10px;
          pointer-events: none;
          z-index: 4;
        }
        .widget-window-root .widget-clip {
          position: absolute;
          inset: 0;
          overflow: hidden;
        }
        .widget-window-root .widget-clip.widget-clip-rounded {
          border-radius: 10px;
        }
        .widget-window-root iframe {
          width: 100%;
          height: 100%;
          border: 0;
          display: block;
        }
        .widget-window-root .widget-pending {
          position: absolute;
          inset: 0;
          z-index: 1;
          background-color: ${cssVars.colors.bg};
        }
        .widget-window-root .widget-remove-button {
          position: absolute;
          top: 6px;
          right: 6px;
          width: 26px;
          height: 26px;
          display: grid;
          place-items: center;
          border: 1px solid ${cssVars.colors.bgAccentPrimary};
          border-radius: 8px;
          background-color: transparent;
          color: ${cssVars.colors.bgAccentPrimary};
          cursor: pointer;
          z-index: 4;
        }
        .widget-window-root .widget-remove-button.widget-remove-center-x {
          right: auto;
          left: 50%;
          transform: translateX(-50%);
        }
        .widget-window-root .widget-remove-button.widget-remove-center-y {
          top: 50%;
          transform: translateY(-50%);
        }
        .widget-window-root .widget-remove-button.widget-remove-center-x.widget-remove-center-y {
          transform: translate(-50%, -50%);
        }
        .widget-window-root .widget-fresh-border {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          z-index: 3;
        }
        .widget-window-root .widget-fresh-border rect {
          fill: none;
          stroke: ${cssVars.colors.bgAccentPrimary};
          stroke-width: 2px;
          vector-effect: non-scaling-stroke;
          stroke-dasharray: 25 75;
          animation: widgetFreshBorder 2.4s linear infinite;
        }
        @keyframes widgetFreshBorder {
          to {
            stroke-dashoffset: -100;
          }
        }
        .widget-window-root .widget-resize-node {
          position: absolute;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background-color: ${cssVars.colors.bgAccentPrimary};
          border: 0;
          padding: 0;
          z-index: 5;
          pointer-events: auto;
          touch-action: none;
        }
        .widget-window-root .widget-resize-node::before,
        .widget-window-root .widget-resize-node::after {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: 50%;
          border: 2px solid ${cssVars.colors.bg};
          pointer-events: none;
        }
        .widget-window-root .widget-resize-node.top::before,
        .widget-window-root .widget-resize-node.top::after,
        .widget-window-root .widget-resize-node.bottom::before,
        .widget-window-root .widget-resize-node.bottom::after {
          -webkit-mask-image: linear-gradient(
            to bottom,
            black 0%,
            black 34%,
            transparent 38%,
            transparent 62%,
            black 66%,
            black 100%
          );
          mask-image: linear-gradient(
            to bottom,
            black 0%,
            black 34%,
            transparent 38%,
            transparent 62%,
            black 66%,
            black 100%
          );
        }
        .widget-window-root .widget-resize-node.left::before,
        .widget-window-root .widget-resize-node.left::after,
        .widget-window-root .widget-resize-node.right::before,
        .widget-window-root .widget-resize-node.right::after {
          -webkit-mask-image: linear-gradient(
            to right,
            black 0%,
            black 34%,
            transparent 38%,
            transparent 62%,
            black 66%,
            black 100%
          );
          mask-image: linear-gradient(
            to right,
            black 0%,
            black 34%,
            transparent 38%,
            transparent 62%,
            black 66%,
            black 100%
          );
        }
        .widget-window-root .widget-resize-node.top::before {
          clip-path: inset(0 0 50% 0);
        }
        .widget-window-root .widget-resize-node.bottom::before {
          clip-path: inset(50% 0 0 0);
        }
        .widget-window-root .widget-resize-node.left::before {
          clip-path: inset(0 50% 0 0);
        }
        .widget-window-root .widget-resize-node.right::before {
          clip-path: inset(0 0 0 50%);
        }
        .widget-window-root .widget-resize-node.top::after {
          clip-path: inset(50% 0 0 0);
        }
        .widget-window-root .widget-resize-node.bottom::after {
          clip-path: inset(0 0 50% 0);
        }
        .widget-window-root .widget-resize-node.left::after {
          clip-path: inset(0 0 0 50%);
        }
        .widget-window-root .widget-resize-node.right::after {
          clip-path: inset(0 50% 0 0);
        }
        .widget-window-root .widget-resize-node.top {
          top: -5px;
          left: calc(50% - 6px);
          cursor: ns-resize;
        }
        .widget-window-root .widget-resize-node.bottom {
          bottom: -5px;
          left: calc(50% - 6px);
          cursor: ns-resize;
        }
        .widget-window-root .widget-resize-node.left {
          left: -5px;
          top: calc(50% - 6px);
          cursor: ew-resize;
        }
        .widget-window-root .widget-resize-node.right {
          right: -5px;
          top: calc(50% - 6px);
          cursor: ew-resize;
        }
        @media (prefers-reduced-motion: reduce) {
          .widget-window-root .widget-fresh-border rect {
            animation: none;
            stroke-dasharray: none;
          }
        }
      `}</style>
      ${!isClosed
        ? this.h`
          <div
            class=${{
              'widget-clip': true,
              'widget-clip-rounded': isFresh || showSolidBorder
            }}
          >
            <iframe
              class='widget-iframe'
              style=${iframeStyle}
              allow='fullscreen; screen-wake-lock; ambient-light-sensor;
                     autoplay; midi; encrypted-media;
                     accelerometer; gyroscope; magnetometer; xr-spatial-tracking;
                     clipboard-read; clipboard-write; web-share;
                     camera; microphone; geolocation; bluetooth; payment'
              ref=${store.appIframeRef$}
              src=${store.appIframeSrc$()}
            />
            ${store.showPending$()
              ? this.h`
                <div class='widget-pending'>
                  <pending-indicator props=${{ text: t('Opening app...'), compact: true }} />
                </div>
              `
              : ''}
          </div>
        `
        : ''}
      ${isFresh && !showSolidBorder
        ? this.h`
          <svg
            class='widget-fresh-border'
            viewBox=${`0 0 ${Math.max(1, cellWidth)} ${Math.max(1, cellHeight)}`}
            preserveAspectRatio='none'
            aria-hidden='true'
          >
            <rect
              x='1'
              y='1'
              width=${Math.max(0, cellWidth - 2)}
              height=${Math.max(0, cellHeight - 2)}
              rx='10'
              pathLength='100'
            />
          </svg>
        `
        : ''}
      ${store.selected$() || isClosed
        ? this.h`
          <button
            class=${{
              'widget-remove-button': true,
              'widget-remove-center-x': placement.w === 1,
              'widget-remove-center-y': placement.h === 1
            }}
            onclick=${removeWidgetNow}
            aria-label=${t('Remove Widget')}
          >
            <icon-close props=${{ size: '16px' }} />
          </button>
        `
        : ''}
      ${(showNodes ? ['top', 'right', 'bottom', 'left'] : []).map(node => this.h({ key: node })`
        <button
          class=${`widget-resize-node ${node}`}
          aria-label=${`Resize ${node}`}
          onpointerdown=${event => beginResize(node, event)}
        ></button>
      `)}
    </div>
  `
})

function getLocales () {
  return {
    'Add Widget': {
      en: 'Add Widget', fr: 'Ajouter un widget', it: 'Aggiungi widget', de: 'Widget hinzufügen',
      es: 'Añadir widget', 'pt-BR': 'Adicionar Widget', ru: 'Добавить виджет', 'zh-CN': '添加小组件',
      'zh-TW': '新增小工具', ja: 'ウィジェットを追加', ko: '위젯 추가'
    },
    'Remove Widget': {
      en: 'Remove Widget', fr: 'Retirer le widget', it: 'Rimuovi widget', de: 'Widget entfernen',
      es: 'Quitar widget', 'pt-BR': 'Remover Widget', ru: 'Удалить виджет', 'zh-CN': '移除小组件',
      'zh-TW': '移除小工具', ja: 'ウィジェットを削除', ko: '위젯 제거'
    },
    'Opening app...': {
      en: 'Opening app...', fr: 'Ouverture de l’application…', it: 'Apertura app…', de: 'App wird geöffnet…',
      es: 'Abriendo app…', 'pt-BR': 'Abrindo app...', ru: 'Открытие приложения…', 'zh-CN': '正在打开应用…',
      'zh-TW': '正在開啟應用程式…', ja: 'アプリを開いています…', ko: '앱 여는 중…'
    }
  }
}
