// A selected widget's body belongs to launcher editing. Start its next drag
// in the launcher document: Chromium can strand a pending capture inside an
// out-of-process iframe when the next movement already leaves that iframe.
export function createWidgetDragSurface ({ window, canStart, getCaptureTarget, onStart, onMove, onEnd }) {
  let pointer = null
  const captureOptions = { capture: true }
  const touchOptions = { capture: true, passive: false }
  const consume = event => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const release = () => {
    if (!pointer) return
    const previous = pointer
    pointer = null
    window.removeEventListener('pointermove', move, captureOptions)
    window.removeEventListener('pointerup', finish, captureOptions)
    window.removeEventListener('pointercancel', finish, captureOptions)
    window.removeEventListener('lostpointercapture', finish, captureOptions)
    window.removeEventListener('contextmenu', consume, captureOptions)
    window.removeEventListener('touchstart', consume, touchOptions)
    window.removeEventListener('touchmove', consume, touchOptions)
    window.removeEventListener('blur', blur)
    try { previous.target.releasePointerCapture(previous.id) } catch { /* already released */ }
  }
  const finish = event => {
    if (!pointer || (event && event.pointerId !== pointer.id)) return
    if (event) consume(event)
    release() // clear before releasePointerCapture can emit lostpointercapture
    onEnd()
  }
  const blur = () => finish()
  const move = event => {
    if (!pointer || event.pointerId !== pointer.id) return
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      finish(event)
      return
    }
    consume(event)
    onMove(event.clientX, event.clientY)
  }
  return {
    onPointerDown (event) {
      if (pointer || event.isPrimary === false || event.button > 0 || !canStart()) return
      const target = getCaptureTarget()
      if (!target) return
      consume(event)
      pointer = { id: event.pointerId, target }
      window.addEventListener('pointermove', move, captureOptions)
      window.addEventListener('pointerup', finish, captureOptions)
      window.addEventListener('pointercancel', finish, captureOptions)
      window.addEventListener('lostpointercapture', finish, captureOptions)
      window.addEventListener('contextmenu', consume, captureOptions)
      // Cancel native long-press recognition and compatibility clicks before
      // they can compete with the selected widget's pointer gesture.
      window.addEventListener('touchstart', consume, touchOptions)
      window.addEventListener('touchmove', consume, touchOptions)
      window.addEventListener('blur', blur)
      try { target.setPointerCapture(event.pointerId) } catch { /* window listeners still catch release */ }
      onStart(event.clientX, event.clientY)
    },
    release
  }
}
