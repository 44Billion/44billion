import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFile } from 'node:fs/promises'

describe('widgets and personas wiring', () => {
  it('exposes the persona APIs from the app page', async () => {
    const appPage = await readFile(
      new URL('../../src/scripts/app-page.txt.js', import.meta.url),
      'utf8'
    )
    assert.match(appPage, /getPersonaPublicKeys/)
    assert.match(appPage, /getWindowNostrFor/)
    assert.match(appPage, /WINDOW_NAPP/)
    assert.match(appPage, /userPk: pubkey/)
    assert.match(appPage, /AUTO_FIT_MIN_ZOOM/)
    assert.match(appPage, /startAutoFit/)
    assert.match(appPage, /setMinWidth/)
    assert.match(appPage, /startViewTransition/)
    assert.match(appPage, /computeAutoFitZoom/)
    assert.match(appPage, /getOpaqueAutoFitBackground/)
    assert.match(appPage, /::view-transition-old\(root\)/)
    assert.doesNotMatch(appPage, /requestAutoFitWide/)
    assert.doesNotMatch(appPage, /reportOverflow/)
    assert.match(appPage, /WIDGET_DRAG/)
    assert.match(appPage, /WIDGET_SELECT_MODE/)
    assert.match(appPage, /installWidgetDragListener/)
    assert.match(appPage, /selectstart/)
    assert.match(appPage, /dragstart/)
    assert.match(appPage, /pointerType === 'touch' \|\| event\.pointerType === 'pen'/)
    assert.match(appPage, /webkitTouchCallout/)
    assert.match(appPage, /touchAction/)
    assert.match(appPage, /state\.pointerId !== null/)
    assert.match(appPage, /forceEndWidgetDrag/)
    assert.match(appPage, /setPointerCapture/)
    assert.match(appPage, /lostpointercapture/)
    assert.match(appPage, /touchcancel/)
    assert.match(appPage, /visibilitychange/)
    assert.match(appPage, /pagehide/)
    assert.match(appPage, /stale-pointerdown/)
    assert.doesNotMatch(appPage, /state\.active\) forceEndWidgetDrag\('contextmenu'\)/)
    assert.match(appPage, /finalizeFirstFit/)
    assert.match(appPage, /originalConsole/)
    assert.match(appPage, /appConsoleDebug/)
  })

  it('routes persona requests and scoped NIP07 calls through the app bridge', async () => {
    const appBridge = await readFile(
      new URL('../../src/helpers/window-message/app-bridge.js', import.meta.url),
      'utf8'
    )
    assert.match(appBridge, /case 'WINDOW_NAPP'/)
    assert.match(appBridge, /op === 'getPersonaPublicKeys'/)
    assert.match(appBridge, /PUBKEY_NOT_IN_PERSONA/)
    assert.match(appBridge, /instanceKind === 'widget'/)
    assert.match(appBridge, /session_widgetByKey_\$\{appKey\}_route/)
    assert.match(appBridge, /permissionMeta/)
    assert.match(appBridge, /isWidget: instanceKind === 'widget'/)
    assert.match(appBridge, /case 'AUTO_FIT'/)
    assert.match(appBridge, /onSetMinWidth/)
    assert.match(appBridge, /onWidgetDrag/)
    assert.doesNotMatch(appBridge, /onAutoFitOverflow/)
  })

  it('registers the widgets layer and Add Widget menu entry', async () => {
    const screen = await readFile(
      new URL('../../src/components/zones/screen/index.js', import.meta.url),
      'utf8'
    )
    const widgets = await readFile(
      new URL('../../src/components/zones/screen/widgets/index.js', import.meta.url),
      'utf8'
    )
    assert.match(screen, /widgets-layer/)
    assert.match(screen, /Add Widget/)
    assert.match(screen, /z-index: 2/)
    assert.match(screen, /widgetsRevealActive/)
    assert.match(screen, /widgets-reveal-active/)
    assert.match(screen, /toolbar-app-launcher > div/)
    assert.match(screen, /user-select: none/)
    assert.match(widgets, /fitWidgets/)
    assert.match(widgets, /WIDGET_MINIMIZED_TTL_MS/)
    assert.match(widgets, /WIDGET_AUTO_FIT_MIN_WIDTH/)
    assert.match(widgets, /shouldApplyVirtualWidth/)
    assert.match(widgets, /onSetMinWidth/)
    assert.doesNotMatch(widgets, /onAutoFitDone/)
    assert.match(screen, /shouldApplyVirtualWidth/)
    assert.match(screen, /onSetMinWidth/)
    assert.match(widgets, /Remove Widget/)
    assert.match(widgets, /pending-indicator/)
    assert.doesNotMatch(widgets, /icon-grip-vertical/)
    assert.doesNotMatch(widgets, /icon-pin/)
    assert.doesNotMatch(widgets, /Pin URL/)
    assert.doesNotMatch(widgets, /widget-creation-overlay/)
    assert.match(widgets, /widgets-dots/)
    assert.match(widgets, /scroll-snap-type/)
    assert.match(widgets, /widgets-page-snap/)
    assert.match(widgets, /touch-action: pan-x/)
    assert.match(widgets, /pointerType === 'mouse'/)
    assert.match(widgets, /onwheel/)
    assert.match(widgets, /deltaX/)
    assert.match(widgets, /widget-page-dot/)
    assert.match(widgets, /scrollbar-width: none/)
    assert.match(widgets, /currentPage/)
    assert.match(widgets, /margin \+ placement\.col \* \(cell \+ gap\)/)
    assert.match(widgets, /resizeWidgetFromNode/)
    assert.match(widgets, /widget-resize-node/)
    assert.match(widgets, /widget-resize-node-hit/)
    assert.match(widgets, /forceEndResize/)
    assert.match(widgets, /onResizeLostCapture/)
    assert.match(widgets, /onResizeContextMenu/)
    assert.match(widgets, /pointerId !== resize\.pointerId/)
    assert.match(widgets, /endActiveGesture/)
    assert.match(widgets, /pagehide/)
    assert.match(widgets, /widgetFresh\$/)
    assert.match(widgets, /WIDGET_SELECT_MODE/)
    assert.match(widgets, /widget-remove-button/)
    assert.match(widgets, /selected\$\(\) && !store\.dragging\$\(\)/)
    assert.match(widgets, /strokeWidth: 3/)
    assert.match(widgets, /outlineColor/)
    assert.match(widgets, /box-shadow: 0 0 0 1px/)
    assert.match(widgets, /widgetDragDraft/)
    assert.match(widgets, /anchorKey/)
    assert.match(widgets, /applyWidgetPositions/)
    assert.match(widgets, /createdScroll/)
    assert.match(widgets, /previousPage/)
    assert.match(widgets, /widgetDragging\$/)
    assert.match(widgets, /widgetDragMoved\$/)
    assert.match(widgets, /tabVisible\$/)
    assert.match(widgets, /targetPage\$/)
    assert.match(widgets, /targetPage\$\(\) !== null \? targetPage\$\(\) : currentPage\$\(\)/)
    assert.match(widgets, /shouldOpenNow/)
    assert.match(widgets, /widgets-grid-dots/)
    assert.doesNotMatch(widgets, /IntersectionObserver/)
    assert.match(widgets, /z-index:1000/)
    assert.match(widgets, /DRAG_PAGE_FLIP_DELAY_MS/)
    assert.match(widgets, /DRAG_PAGE_FLIP_THROTTLE_MS/)
    assert.match(widgets, /scheduleDragAutoFlip/)
    assert.match(widgets, /widgetDragEdge/)
    assert.match(widgets, /widget-edge-gradient/)
  })

  it('keeps compact loading and the mini ostrich theme', async () => {
    const pending = await readFile(
      new URL('../../src/components/shared/pending-indicator.js', import.meta.url),
      'utf8'
    )
    const loader = await readFile(
      new URL('../../src/assets/html/app-page-loader.txt.html', import.meta.url),
      'utf8'
    )
    assert.match(pending, /pending-indicator-compact/)
    assert.match(loader, /max-width: 240px/)
    assert.match(loader, /#pixel-ostrich/)
    assert.match(loader, /scale\(0\.5\)/)
  })

  it('registers the new storage keys in the schema and permission dialog badges', async () => {
    const schema = await readFile(
      new URL('../../src/constants/storage-schema.js', import.meta.url),
      'utf8'
    )
    const permission = await readFile(
      new URL('../../src/components/zones/permission-dialog/index.js', import.meta.url),
      'utf8'
    )
    assert.match(schema, /local_widgets/)
    assert.match(schema, /local_personas/)
    assert.match(schema, /local_appPersonaSelections/)
    assert.match(permission, /widget-badge/)
    assert.match(permission, /accountUserPk/)
  })
})
