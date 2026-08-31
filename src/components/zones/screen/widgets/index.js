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
import '#shared/pending-indicator.js'
import '#shared/icons/icon-grip-vertical.js'
import '#shared/icons/icon-pin.js'
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
  BASE_CELL,
  computeEffectiveGrid,
  fitWidgets,
  removeWidget,
  readWidgetSessionValue,
  setWidgetPinnedRoute,
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
const WIDGET_PLACEHOLDER_KEY = '__creation_placeholder__'

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

// Style used inside a viewport-fixed page overlay: the overlay root already
// starts at the page content area (left margin), so only the page-local column
// offset plus the global top margin are applied.
function pageLocalPlacementStyle (placement, grid) {
  if (!placement || !grid) return null
  const cell = grid.cell || BASE_CELL
  const gap = grid.gap || GAP
  const margin = grid.margin || GAP
  const col = placement.col % grid.cols
  return `left:${col * (cell + gap)}px;top:${margin + placement.row * (cell + gap)}px;` +
    `width:${placement.w * cell + (placement.w - 1) * gap}px;` +
    `height:${placement.h * cell + (placement.h - 1) * gap}px;`
}

f('widgets-layer', function () {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const { order$ } = useActiveWorkspaceOrder(storage, tabStorage)
  const draft$ = useGlobalSignal('widgetsDraft', null)
  const dragDraft$ = useGlobalSignal('widgetDragDraft', null)
  const dragEdge$ = useGlobalSignal('widgetDragEdge', null)
  const creationDraft$ = useGlobalSignal('widgetCreationDraft', null)
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
    const drag = dragDraft$()
    let entries = drag?.widgetKey
      ? widgets.map(widget =>
        widget.widgetKey === drag.widgetKey
          ? { ...widget, row: drag.row, col: drag.col }
          : widget
      )
      : widgets
    let anchorKey = drag?.widgetKey ?? null
    const creation = creationDraft$()
    if (creation) {
      entries = [...entries, {
        widgetKey: WIDGET_PLACEHOLDER_KEY,
        row: creation.row,
        col: creation.col,
        desired: { w: creation.w, h: creation.h },
        createdAt: 0,
        order: -1
      }]
      anchorKey = WIDGET_PLACEHOLDER_KEY
    }
    if (widgets.length === 0 && !creation) return { placements: [], pageCount: 1 }
    return fitWidgets(entries, {
      viewportCols: grid.cols,
      viewportRows: grid.rows,
      anchorKey
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
  const draft = draft$()
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
      ${draft
        ? this.h`<widget-creation-overlay props=${{
          appId: draft.appId,
          wsKey: draft.wsKey,
          pinnedRoute: draft.pinnedRoute,
          pageWidth,
          grid$: store.grid$
        }} />`
        : ''}
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
        ${pageCount > 1
          ? visiblePages$().map(page => this.h({ key: page })`
            <button
              class=${{
                'widget-page-dot': true,
                active: page === store.currentPage$()
              }}
              aria-label=${`Page ${page + 1}`}
              onclick=${() => onDotClick(page)}
            ></button>
          `)
          : ''}
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
    controls$: false,
    dragging$: false,
    elRef$: null,
    appIframeRef$: null,
    appIframeSrc$: 'about:blank',
    appReady$: false,
    showPending$: false,
    launchError$: null,
    wideMode$: false,
    iframeReevalHidden$: false,
    minWidth$: WIDGET_AUTO_FIT_MIN_WIDTH
  }))

  const runtime = useMemo(() => ({
    startedGeneration: null,
    appReady: false,
    autoRetried: false,
    appCleanup: null,
    routeVersion: 0,
    loadedRouteVersion: -1
  }))

  const placement$ = useComputed(() => layout$()[widgetKey] ?? null)
  const cellWidth$ = useComputed(() => {
    const placement = placement$()
    if (!placement) return null
    const grid = grid$()
    return placement.w * (grid.cell + grid.gap) - grid.gap
  })

  // Apply/re-evaluate the virtual width whenever the cell width or the app's
  // minWidth changes; toggles happen under cover (iframe hidden until `done`).
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
    if (modeChanged || (applyWide && minWidthChanged)) store.iframeReevalHidden$(true)
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
      if (!appId || !wsKey) return
      const userPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
      const appSubdomain = userPk && appId
        ? storage[`session_subdomainByUserAndApp_${userPk}_${appId}$`]()
        : null
      const pinnedRoute = store.record$()?.pinnedRoute ?? ''
      const route = readWidgetSessionValue(sessionStorage, widgetKey, 'route') ?? pinnedRoute
      store.launchError$(null)

      if (isClosed || !appId || !userPk) {
        store.appIframeSrc$('about:blank')
        store.appIframeRef$(null)
        store.appReady$(false)
        store.showPending$(false)
        store.wideMode$(false)
        store.iframeReevalHidden$(false)
        store.minWidth$(WIDGET_AUTO_FIT_MIN_WIDTH)
        runtime.appCleanup?.()
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

      const ac = new AbortController()
      cleanup(() => ac.abort())
      const bridgeState = ensureAppBridgeState(appSubdomain, { userPk, appId })
      const unregister = registerAppBridgeWindow(bridgeState, {
        appKey: widgetKey,
        onClose () {
          if (store.visibility$() === 'open') setVisibility('minimized')
        },
        onSetMinWidth (minWidth) {
          const value = Math.round(Number(minWidth))
          if (!Number.isFinite(value) || value < 0) {
            console.warn('[widget-window] Invalid minWidth', minWidth)
            return
          }
          store.minWidth$(value)
        },
        onAutoFitDone () {
          store.iframeReevalHidden$(false)
        }
      })
      cleanup(unregister)

      const [bridgeReady, bridgeError, bridgeRetryCount] = track(() => [
        bridgeState.ready$(),
        bridgeState.error$(),
        bridgeState.retryCount$()
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
      if (
        runtime.startedGeneration === bridgeRetryCount &&
        runtime.appReady &&
        runtime.loadedRouteVersion === runtime.routeVersion
      ) return

      runtime.appCleanup?.()
      runtime.appCleanup = null
      runtime.startedGeneration = bridgeRetryCount
      runtime.appReady = false
      store.appReady$(false)
      store.launchError$(null)

      const onAppReady = () => {
        store.showPending$(false)
        runtime.appReady = true
        store.appReady$(true)
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
      cleanup(cleanupApp)
    },
    { after: 'rendering' }
  )

  // Hide controls when the user interacts elsewhere.
  useTask(({ cleanup }) => {
    const onPointerDown = event => {
      const root = store.elRef$()
      if (root && root.contains(event.target)) return
      if (store.controls$()) store.controls$(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    cleanup(() => window.removeEventListener('pointerdown', onPointerDown, true))
  })

  // Long-press (touch) and context menu (mouse) reveal the overlay controls.
  const longPressTimer = useMemo(() => ({ id: null }))
  const onRootPointerDown = event => {
    if (event.pointerType !== 'touch') return
    clearTimeout(longPressTimer.id)
    longPressTimer.id = setTimeout(() => {
      store.controls$(true)
    }, LONG_PRESS_MS)
  }
  const onRootPointerUp = () => clearTimeout(longPressTimer.id)
  const onRootContextMenu = event => {
    event.preventDefault()
    store.controls$(true)
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
  const pinCurrentRoute = () => {
    const route = store.route$()
    if (!route) return
    setWidgetPinnedRoute({
      localStorageArea: localStorage,
      widgetKey,
      pinnedRoute: route
    })
  }
  const canPin$ = useComputed(() => {
    const record = store.record$()
    const route = store.route$()
    return Boolean(record && route && route !== record.pinnedRoute)
  })

  // Drag to move the widget.
  const drag = useMemo(() => ({
    active: false,
    startX: 0,
    startY: 0,
    startRow: 0,
    startCol: 0,
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
  const beginDrag = event => {
    if (drag.active || event.button === 2) return
    const placement = placement$()
    if (!placement) return
    event.preventDefault()
    event.stopPropagation()
    drag.active = true
    drag.startX = event.clientX
    drag.startY = event.clientY
    drag.startRow = placement.row
    drag.startCol = placement.col
    store.controls$(false)
    dragDraft$({
      widgetKey,
      col: placement.col,
      row: placement.row,
      w: placement.w,
      h: placement.h
    })
    store.dragging$(true)
    window.addEventListener('pointermove', onDragMove, { capture: true })
    window.addEventListener('pointerup', onDragEnd, { capture: true })
  }
  const onDragMove = event => {
    if (!drag.active) return
    const grid = grid$()
    const size = placement$()
    if (!size || !grid) return
    const cell = grid.cell + grid.gap
    let row = drag.startRow + Math.round((event.clientY - drag.startY) / cell)
    let col = drag.startCol + Math.round((event.clientX - drag.startX) / cell)
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
    drag.lastClientX = event.clientX
    const rect = scrollEl.getBoundingClientRect()
    const dir = event.clientX >= rect.right - DRAG_EDGE_ZONE
      ? 1
      : event.clientX <= rect.left + DRAG_EDGE_ZONE
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
  const onDragEnd = () => {
    if (!drag.active) return
    drag.active = false
    stopDragAutoFlip()
    window.removeEventListener('pointermove', onDragMove, { capture: true })
    window.removeEventListener('pointerup', onDragEnd, { capture: true })
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
  const iframeVisibility = store.iframeReevalHidden$() ? 'hidden' : ''
  const virtualWidth = store.minWidth$()
  const iframeStyle = wide && cellWidth > 0 && virtualWidth > 0
    ? `position:absolute;top:0;left:0;width:${virtualWidth}px;` +
      `height:${Math.round(cellHeight * virtualWidth / cellWidth)}px;` +
      `transform:scale(${cellWidth / virtualWidth});` +
      `transform-origin:top left;${iframeVisibility ? `visibility:${iframeVisibility};` : ''}`
    : (iframeVisibility ? `visibility:${iframeVisibility};` : '')

  return this.h`
    <div
      class=${{
        'widget-window-root': true,
        'widget-window-open': visibility === 'open',
        'widget-window-minimized': visibility === 'minimized',
        'widget-window-closed': isClosed,
        'widget-controls-visible': store.controls$() || store.dragging$()
      }}
      style=${store.dragging$() ? `${style}z-index:1000;` : style}
      ref=${store.elRef$}
      onpointerdown=${onRootPointerDown}
      onpointerup=${onRootPointerUp}
      oncontextmenu=${onRootContextMenu}
    >
      <style>${/* css */`
        .widget-window-root {
          position: absolute;
          overflow: hidden;
          clip-path: inset(0);
          border-radius: 8px;
          background-color: ${cssVars.colors.bg};
          box-shadow: 0 2px 8px ${cssVars.colors.shadow};
          cursor: default;
        }
        .widget-window-root.widget-window-closed {
          background-color: transparent;
          box-shadow: none;
          border: 1px dashed ${cssVars.colors.fg3};
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
        .widget-window-root .widget-controls {
          position: absolute;
          top: 4px;
          right: 4px;
          display: flex;
          gap: 4px;
          opacity: 0;
          transition: opacity .15s ease;
          z-index: 2;
        }
        .widget-window-root:hover .widget-controls,
        .widget-window-root.widget-controls-visible .widget-controls,
        .widget-window-root:focus-within .widget-controls {
          opacity: 1;
        }
        .widget-window-root .widget-control-button {
          width: 26px;
          height: 26px;
          display: grid;
          place-items: center;
          border: 0;
          border-radius: 6px;
          background-color: ${cssVars.colors.bg2Lighter};
          color: ${cssVars.colors.fg2};
          cursor: pointer;
          box-shadow: 0 1px 4px ${cssVars.colors.shadow};
        }
        .widget-window-root .widget-grip {
          position: absolute;
          top: 4px;
          left: 4px;
          width: 26px;
          height: 26px;
          display: grid;
          place-items: center;
          border: 0;
          border-radius: 6px;
          background-color: ${cssVars.colors.bg2Lighter};
          color: ${cssVars.colors.fg2};
          cursor: grab;
          opacity: 0;
          transition: opacity .15s ease;
          z-index: 2;
          touch-action: none;
        }
        .widget-window-root:hover .widget-grip,
        .widget-window-root.widget-controls-visible .widget-grip {
          opacity: 1;
        }
        .widget-window-root .widget-grip:active {
          cursor: grabbing;
        }
        .widget-window-root.widget-window-closed .widget-controls,
        .widget-window-root.widget-window-closed .widget-grip {
          opacity: 1;
        }
      `}</style>
      ${!isClosed
        ? this.h`
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
        `
        : ''}
      <button class='widget-grip' onpointerdown=${beginDrag} aria-label=${t('Move widget')}>
        <icon-grip-vertical props=${{ size: '16px' }} />
      </button>
      <div class='widget-controls'>
        ${canPin$()
          ? this.h`
            <button class='widget-control-button' onclick=${pinCurrentRoute} aria-label=${t('Pin URL')}>
              <icon-pin props=${{ size: '16px' }} />
            </button>
          `
          : ''}
        <button class='widget-control-button' onclick=${removeWidgetNow} aria-label=${t('Remove Widget')}>
          <icon-close props=${{ size: '16px' }} />
        </button>
      </div>
    </div>
  `
})

f('widget-creation-overlay', function () {
  const draft$ = useGlobalSignal('widgetsDraft', null)
  const creationDraft$ = useGlobalSignal('widgetCreationDraft', null)
  const dragEdge$ = useGlobalSignal('widgetDragEdge', null)
  const store = useStore(() => ({
    elRef$: null,
    preview$: null,
    dragging$: false
  }))

  useTask(({ cleanup }) => {
    const onKeyDown = event => {
      if (event.key === 'Escape') cancelDrag()
    }
    window.addEventListener('keydown', onKeyDown)
    cleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  const drag = useMemo(() => ({
    active: false,
    startX: 0,
    startY: 0,
    startRow: 0,
    startCol: 0,
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
      const grid = this.props.grid$()
      if (!grid || !scrollEl.isConnected) return
      const step = grid.pageWidth + grid.gap
      const current = Math.round(scrollEl.scrollLeft / step)
      const next = Math.max(0, current + dir)
      if (next === current) return
      drag.lastFlipAt = Date.now()
      drag.startCol += dir * grid.cols
      creationDraft$(draft => draft
        ? { ...draft, col: draft.col + dir * grid.cols }
        : draft)
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

  const grid = this.props.grid$()
  const pageWidth = Math.max(this.props.pageWidth ?? 1, 1)
  const desired = grid.cols >= WIDGET_DEFAULT_DESIRED.w && grid.rows >= WIDGET_DEFAULT_DESIRED.h
    ? WIDGET_DEFAULT_DESIRED
    : { w: 1, h: 1 }
  const initialPreview = { col: 0, row: 0, ...desired }

  const beginDrag = event => {
    if (drag.active) return
    event.preventDefault()
    event.stopPropagation()
    const currentGrid = this.props.grid$()
    const scrollEl = store.elRef$()?.closest?.('#widgets-scroll')
    const step = currentGrid.pageWidth + currentGrid.gap
    const currentPage = scrollEl && step > 0
      ? Math.max(0, Math.round(scrollEl.scrollLeft / step))
      : 0
    drag.active = true
    drag.startX = event.clientX
    drag.startY = event.clientY
    drag.startRow = 0
    drag.startCol = currentPage * currentGrid.cols
    creationDraft$({
      col: drag.startCol,
      row: 0,
      w: desired.w,
      h: desired.h
    })
    store.preview$({ ...initialPreview })
    store.dragging$(true)
    window.addEventListener('pointermove', onMove, { capture: true })
    window.addEventListener('pointerup', onEnd, { capture: true })
  }
  const onMove = event => {
    if (!drag.active) return
    const currentGrid = this.props.grid$()
    if (!currentGrid) return
    const cell = currentGrid.cell + currentGrid.gap
    let row = Math.round((event.clientY - drag.startY) / cell)
    let col = drag.startCol + Math.round((event.clientX - drag.startX) / cell)
    row = Math.max(0, Math.min(row, currentGrid.rows - desired.h))
    const currentDraft = creationDraft$()
    const currentPage = Math.max(
      0,
      Math.floor((currentDraft?.col ?? col) / currentGrid.cols)
    )
    const minCol = currentPage * currentGrid.cols
    const maxCol = currentPage * currentGrid.cols +
      Math.max(0, currentGrid.cols - desired.w)
    col = Math.max(minCol, Math.min(col, maxCol))
    creationDraft$(draft => draft
      ? { ...draft, col, row }
      : draft)
    store.preview$({
      col: col % currentGrid.cols,
      row,
      w: desired.w,
      h: desired.h
    })
    const scrollEl = store.elRef$()?.closest?.('#widgets-scroll')
    if (!scrollEl) return
    drag.lastClientX = event.clientX
    const rect = scrollEl.getBoundingClientRect()
    const dir = event.clientX >= rect.right - DRAG_EDGE_ZONE
      ? 1
      : event.clientX <= rect.left + DRAG_EDGE_ZONE
        ? -1
        : 0
    if (dir !== 0) {
      const step = currentGrid.pageWidth + currentGrid.gap
      const current = Math.round(scrollEl.scrollLeft / step)
      dragEdge$(dir === 1 ? 'right' : current > 0 ? 'left' : null)
      scheduleDragAutoFlip(scrollEl, dir)
    } else {
      dragEdge$(null)
      stopDragAutoFlip()
    }
  }
  const onEnd = () => {
    if (!drag.active) return
    drag.active = false
    stopDragAutoFlip()
    window.removeEventListener('pointermove', onMove, { capture: true })
    window.removeEventListener('pointerup', onEnd, { capture: true })
    const currentGrid = this.props.grid$()
    const creation = creationDraft$()
    store.dragging$(false)
    store.preview$(null)
    creationDraft$(null)
    const draft = draft$()
    if (!draft || !creation || !currentGrid) return
    const widgetKey = addWidget({
      localStorageArea: localStorage,
      appId: draft.appId,
      wsKey: draft.wsKey,
      row: creation.row,
      col: creation.col,
      desired: { w: creation.w, h: creation.h },
      pinnedRoute: draft.pinnedRoute || ''
    })
    writeWidgetSessionValue(sessionStorage, widgetKey, 'route', draft.pinnedRoute || '')
    writeWidgetSessionValue(sessionStorage, widgetKey, 'visibility', 'open')
    draft$(null)
  }
  const cancelDrag = () => {
    if (drag.active) {
      drag.active = false
      stopDragAutoFlip()
      window.removeEventListener('pointermove', onMove, { capture: true })
      window.removeEventListener('pointerup', onEnd, { capture: true })
    }
    store.dragging$(false)
    store.preview$(null)
    creationDraft$(null)
    dragEdge$(null)
    draft$(null)
  }

  if (!store.dragging$()) {
    return this.h`
      <div
        class='widget-creation-overlay'
        ref=${store.elRef$}
        onclick=${cancelDrag}
        style=${`position:absolute;left:${this.props.grid$().margin}px;top:0;bottom:${GAP}px;width:${pageWidth}px;`}
      >
        <style>${/* css */`
          .widget-creation-overlay {
            position: absolute;
            z-index: 100;
            background-color: color-mix(in srgb, ${cssVars.colors.shadow} 35%, transparent);
            cursor: crosshair;
            pointer-events: auto;
          }
        `}</style>
        <button
          class='widget-creation-placeholder'
          style=${pageLocalPlacementStyle({ col: initialPreview.col, row: initialPreview.row, ...desired }, grid)}
          onpointerdown=${beginDrag}
        >
          <style>${/* css */`
            .widget-creation-overlay .widget-creation-placeholder {
              position: absolute;
              border: 2px dashed ${cssVars.colors.bgAccentPrimary};
              border-radius: 8px;
              background-color: ${cssVars.colors.bgAccentSecondary}33;
              cursor: grab;
              touch-action: none;
            }
          `}</style>
        </button>
      </div>
    `
  }
  return this.h`
    <div
      class='widget-creation-overlay widget-creation-dragging'
      ref=${store.elRef$}
      style=${`position:absolute;left:${this.props.grid$().margin}px;top:0;bottom:${GAP}px;width:${pageWidth}px;`}
    >
      <style>${/* css */`
        .widget-creation-overlay.widget-creation-dragging {
          position: absolute;
          z-index: 100;
          background-color: color-mix(in srgb, ${cssVars.colors.shadow} 20%, transparent);
          cursor: grabbing;
          pointer-events: auto;
        }
        .widget-creation-overlay.widget-creation-dragging .widget-creation-preview {
          position: absolute;
          border: 2px solid ${cssVars.colors.bgAccentPrimary};
          border-radius: 8px;
          background-color: ${cssVars.colors.bgAccentSecondary}55;
        }
      `}</style>
      <div
        class='widget-creation-preview'
        style=${pageLocalPlacementStyle(store.preview$() || initialPreview, this.props.grid$())}
      ></div>
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
    'Pin URL': {
      en: 'Pin URL', fr: 'Épingler l’URL', it: 'Fissa URL', de: 'URL anheften',
      es: 'Fijar URL', 'pt-BR': 'Fixar URL', ru: 'Закрепить URL', 'zh-CN': '固定网址',
      'zh-TW': '釘選網址', ja: 'URLを固定', ko: 'URL 고정'
    },
    'Move widget': {
      en: 'Move widget', fr: 'Déplacer le widget', it: 'Sposta widget', de: 'Widget verschieben',
      es: 'Mover widget', 'pt-BR': 'Mover Widget', ru: 'Переместить виджет', 'zh-CN': '移动小组件',
      'zh-TW': '移動小工具', ja: 'ウィジェットを移動', ko: '위젯 이동'
    },
    'Opening app...': {
      en: 'Opening app...', fr: 'Ouverture de l’application…', it: 'Apertura app…', de: 'App wird geöffnet…',
      es: 'Abriendo app…', 'pt-BR': 'Abrindo app...', ru: 'Открытие приложения…', 'zh-CN': '正在打开应用…',
      'zh-TW': '正在開啟應用程式…', ja: 'アプリを開いています…', ko: '앱 여는 중…'
    }
  }
}
