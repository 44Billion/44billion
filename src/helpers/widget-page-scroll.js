const PAGE_SCROLL_DURATION_MS = 400

// Wheel events can interrupt the browser's smooth scroll and trigger snap-back.
// Own the animation frames, and restore native snapping after landing so touch
// scrolling continues to use the browser's normal page snapping.
export function createWidgetPageScroll () {
  let animation = null
  const cancel = () => {
    if (!animation) return
    const { el, view, frame, snap, priority } = animation
    animation = null
    view.cancelAnimationFrame(frame)
    if (snap) el.style.setProperty('scroll-snap-type', snap, priority)
    else el.style.removeProperty('scroll-snap-type')
  }
  return {
    get active () { return animation !== null },
    get targetPage () { return animation?.page ?? null },
    cancel,
    scrollTo (el, { page, left, onFinish }) {
      cancel()
      const view = el.ownerDocument.defaultView
      const start = el.scrollLeft
      const snap = el.style.getPropertyValue('scroll-snap-type')
      const priority = el.style.getPropertyPriority('scroll-snap-type')
      const reducedMotion = view.matchMedia('(prefers-reduced-motion: reduce)').matches
      const state = { el, view, page, snap, priority, frame: null, startedAt: null }
      animation = state
      el.style.setProperty('scroll-snap-type', 'none')
      const tick = now => {
        if (animation !== state) return
        if (!el.isConnected) {
          cancel()
          return
        }
        state.startedAt ??= now
        const progress = reducedMotion ? 1 : Math.min((now - state.startedAt) / PAGE_SCROLL_DURATION_MS, 1)
        const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2
        const destination = Math.max(0, Math.min(left, el.scrollWidth - el.clientWidth))
        el.scrollTo({ left: start + (destination - start) * eased, behavior: 'instant' })
        if (progress === 1) {
          cancel()
          onFinish()
        } else {
          state.frame = view.requestAnimationFrame(tick)
        }
      }
      state.frame = view.requestAnimationFrame(tick)
    }
  }
}
