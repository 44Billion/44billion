const LONG_PRESS_MS = 600
const MOVE_TOLERANCE = 10
const STALE_MS = 2000
const SELECTION_LOCK = 'data-launcher-widget-selection-lock'
const TOUCH_LOCK = 'data-launcher-widget-touch-lock'

// One client per app-page document. The launcher cannot receive pointer events
// through the cross-origin iframe, so gestures stay here and use its bridge.
export function createWidgetDragClient ({
  window,
  document,
  isWidget,
  sendDrag,
  log = () => {}
}) {
  let selectMode = false
  let lockStyle = null
  let suppressClick = false
  const state = {
    pointerId: null,
    pointerType: null,
    captureTarget: null,
    startX: 0,
    startY: 0,
    timer: null,
    active: false,
    lastSentX: 0,
    lastSentY: 0,
    lastEventAt: 0
  }
  const isEditing = () => isWidget() && (selectMode || state.active)
  const syncLock = () => {
    const root = document.documentElement
    const touchLocked = isEditing()
    const selectionLocked = touchLocked || (isWidget() && state.pointerId !== null &&
      (state.pointerType === 'touch' || state.pointerType === 'pen'))
    if (selectionLocked && !lockStyle) {
      lockStyle = document.createElement('style')
      // Include nested scrollers: touch-action on html/body alone cannot
      // constrain a gesture whose nearest scroll container is inside the app.
      // Attributes toggle our rules without overwriting the app's own styles.
      lockStyle.textContent = `
        html[${SELECTION_LOCK}], html[${SELECTION_LOCK}] * {
          user-select: none !important;
          -webkit-user-select: none !important;
          -webkit-touch-callout: none !important;
        }
        html[${TOUCH_LOCK}], html[${TOUCH_LOCK}] * {
          touch-action: none !important;
        }
      `
      root.appendChild(lockStyle)
    }
    root.toggleAttribute(SELECTION_LOCK, selectionLocked)
    root.toggleAttribute(TOUCH_LOCK, touchLocked)
  }
  const consume = event => {
    if (event.cancelable) event.preventDefault()
    event.stopImmediatePropagation()
  }
  const clearTimer = () => {
    clearTimeout(state.timer)
    state.timer = null
  }
  const forceEndWidgetDrag = reason => {
    if (state.pointerId === null) return
    const { active: wasActive, captureTarget, pointerId } = state
    clearTimer()
    // Clear first: releasePointerCapture can itself cause lostpointercapture.
    state.pointerId = null
    state.pointerType = null
    state.captureTarget = null
    state.active = false
    try { captureTarget?.releasePointerCapture?.(pointerId) } catch { /* pointer may already be gone */ }
    syncLock()
    log('[widget-drag] forced end', { reason, wasActive })
    if (wasActive) sendDrag('end', state.lastSentX, state.lastSentY)
  }
  const activate = event => {
    state.active = true
    suppressClick = true
    syncLock()
    // Leave app capture alone until a drag is actually claimed.
    if (state.pointerType === 'touch' || state.pointerType === 'pen') {
      try { state.captureTarget?.setPointerCapture?.(state.pointerId) } catch { /* pointer may already be gone */ }
    }
    state.lastSentX = event.clientX
    state.lastSentY = event.clientY
    sendDrag('start', event.clientX, event.clientY, event.screenX, event.screenY)
  }
  const onPointerDown = event => {
    if (!isWidget()) return
    log('[widget-drag] pointerdown', {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      selectMode,
      host: window.location.hostname
    })
    if (
      state.pointerId !== null && event.pointerId !== state.pointerId &&
      Date.now() - state.lastEventAt > STALE_MS
    ) forceEndWidgetDrag('stale-pointerdown')
    if (isEditing()) consume(event)
    if (state.pointerId !== null) return
    suppressClick = false
    state.pointerId = event.pointerId
    state.pointerType = event.pointerType
    state.captureTarget = event.target
    state.startX = event.clientX
    state.startY = event.clientY
    state.lastEventAt = Date.now()
    clearTimer()
    syncLock()
    if (selectMode) {
      activate(event)
      return
    }
    state.timer = setTimeout(() => {
      state.timer = null
      log('[widget-drag] long-press fired', { x: event.clientX, y: event.clientY })
      activate(event)
    }, LONG_PRESS_MS)
  }
  const onPointerMove = event => {
    if (!isWidget() || event.pointerId !== state.pointerId) return
    state.lastEventAt = Date.now()
    if (state.timer !== null) {
      if (
        Math.abs(event.clientX - state.startX) > MOVE_TOLERANCE ||
        Math.abs(event.clientY - state.startY) > MOVE_TOLERANCE
      ) clearTimer()
      return
    }
    if (!state.active) return
    consume(event)
    if (
      Math.abs(event.clientX - state.lastSentX) >= 2 ||
      Math.abs(event.clientY - state.lastSentY) >= 2
    ) {
      state.lastSentX = event.clientX
      state.lastSentY = event.clientY
      sendDrag('move', event.clientX, event.clientY, event.screenX, event.screenY)
    }
  }
  const onPointerEnd = event => {
    if (!isWidget() || event.pointerId !== state.pointerId) return
    if (state.active) consume(event)
    forceEndWidgetDrag('pointerend')
  }
  const onContextMenu = event => {
    if (!isWidget() || (!isEditing() && state.pointerId === null)) return
    // A prevented contextmenu must not terminate the live pointer stream.
    consume(event)
  }
  const onEditingEvent = event => {
    if (isEditing()) consume(event)
  }
  const onTouchEnd = event => {
    // pointerup precedes touchend; keep ownership through the whole release.
    if (isWidget() && suppressClick) consume(event)
  }
  const onClick = event => {
    // Keep keyboard/programmatic activation available. The next pointerdown
    // clears this guard, so an ordinary tap after deselection works normally.
    if (isWidget() && suppressClick && event.detail !== 0) consume(event)
  }
  const onTouchCancel = () => {
    if (isWidget()) forceEndWidgetDrag('touchcancel')
  }
  const onLostPointerCapture = event => {
    if (isWidget() && event.pointerId === state.pointerId) {
      forceEndWidgetDrag('lostpointercapture')
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') forceEndWidgetDrag('visibilitychange')
  }
  const onWindowBlur = () => forceEndWidgetDrag('blur')
  const onPageHide = () => forceEndWidgetDrag('pagehide')
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerEnd, true)
  window.addEventListener('pointercancel', onPointerEnd, true)
  window.addEventListener('contextmenu', onContextMenu, true)
  window.addEventListener('selectstart', onEditingEvent, true)
  window.addEventListener('dragstart', onEditingEvent, true)
  // Chrome treats root touch listeners as passive by default. Cancel at
  // touchstart while selected, before its native long-press recognizer fires.
  window.addEventListener('touchstart', onEditingEvent, { capture: true, passive: false })
  window.addEventListener('touchmove', onEditingEvent, { capture: true, passive: false })
  window.addEventListener('touchend', onTouchEnd, { capture: true, passive: false })
  window.addEventListener('touchcancel', onTouchCancel, true)
  window.addEventListener('click', onClick, true)
  window.addEventListener('lostpointercapture', onLostPointerCapture, true)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('blur', onWindowBlur, true)
  window.addEventListener('pagehide', onPageHide, true)

  return {
    setSelectMode (enabled) {
      selectMode = enabled === true
      // This must run on the bridge message, BEFORE the next pointerdown:
      // changing touch-action after a gesture starts is too late for that touch.
      syncLock()
    }
  }
}
