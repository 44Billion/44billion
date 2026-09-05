// Read the actual CSS result instead of duplicating the window MRU and aspect
// ratio rules. Intersect ancestor clips as well as the browser viewport.
export function isInstanceSurfaceDisplayed (element, window) {
  if (!element?.isConnected) return false
  if (window.frameElement && !isInstanceSurfaceDisplayed(window.frameElement, window.parent)) return false
  const rect = element.getBoundingClientRect()
  let left = Math.max(0, rect.left)
  let top = Math.max(0, rect.top)
  let right = Math.min(window.innerWidth, rect.right)
  let bottom = Math.min(window.innerHeight, rect.bottom)
  const ownStyle = window.getComputedStyle(element)
  if (ownStyle.visibility !== 'visible') return false
  for (let node = element; node; node = node.parentElement) {
    const style = window.getComputedStyle(node)
    if (style.display === 'none' || Number(style.opacity) === 0) return false
    if (node === element || style.display === 'contents') continue
    const clipX = /^(hidden|clip|scroll|auto)$/.test(style.overflowX)
    const clipY = /^(hidden|clip|scroll|auto)$/.test(style.overflowY)
    if (clipX || clipY) {
      const clip = node.getBoundingClientRect()
      if (clipX) { left = Math.max(left, clip.left); right = Math.min(right, clip.right) }
      if (clipY) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
    }
  }
  return right > left && bottom > top
}

export function createInstancePresentationObserver (service) {
  const surfaces = new Map()
  let schedule = () => {}
  return {
    register (key, surface) {
      surfaces.set(key, surface)
      schedule()
      return () => {
        if (surfaces.get(key) !== surface) return
        surfaces.delete(key)
        schedule()
      }
    },
    start (window, document, root) {
      let frame = null
      const refresh = () => {
        frame = null
        service.setEnvironment({ tabVisible: document.visibilityState === 'visible' })
        service.setPresentation(new Map([...surfaces].map(([key, surface]) => [key, {
          isWidget: surface.isWidget,
          contentVisible: surface.contentVisible,
          isDisplayed: surface.eligible && isInstanceSurfaceDisplayed(surface.element, window)
        }])))
      }
      schedule = () => {
        if (frame === null) frame = window.requestAnimationFrame(refresh)
      }
      // Hidden tabs may stop animation frames, but must publish invisibility.
      const visibilityChanged = () => {
        service.setEnvironment({ tabVisible: document.visibilityState === 'visible' })
        schedule()
      }
      const observer = new window.MutationObserver(schedule)
      observer.observe(root, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'style']
      })
      const resize = new window.ResizeObserver(schedule)
      resize.observe(root)
      window.addEventListener('resize', schedule)
      window.addEventListener('scroll', schedule, true)
      root.addEventListener('transitionend', schedule, true)
      document.addEventListener('visibilitychange', visibilityChanged)
      visibilityChanged()
      return () => {
        observer.disconnect()
        resize.disconnect()
        window.removeEventListener('resize', schedule)
        window.removeEventListener('scroll', schedule, true)
        root.removeEventListener('transitionend', schedule, true)
        document.removeEventListener('visibilitychange', visibilityChanged)
        if (frame !== null) window.cancelAnimationFrame(frame)
        schedule = () => {}
        service.setPresentation(new Map())
      }
    }
  }
}
