import { useGlobalComputed } from 'thenameisf'

export default function useScrollbarConfig () {
  return useGlobalComputed('useScrollbarConfig', () => {
    const testEl = document.createElement('div')
    testEl.style.cssText = `
      position: absolute;
      top: -9999px;
      width: 100px;
      height: 100px;
      overflow: scroll;
      visibility: hidden;
    `
    document.body.appendChild(testEl)
    const scrollbarWidth = testEl.offsetWidth - testEl.clientWidth
    document.body.removeChild(testEl)
    const hasClassicScrollbar = scrollbarWidth > 0

    return {
      width: scrollbarWidth,
      hasClassic: hasClassicScrollbar,
      hasOverlay: !hasClassicScrollbar,
      className: hasClassicScrollbar ? 'classic-scrollbar' : 'overlay-scrollbar'
    }
  })
}
