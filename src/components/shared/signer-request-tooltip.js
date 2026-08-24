import { f, useStore, useTask } from '#f'
import { cssVars } from '#assets/styles/theme.js'

f('signer-request-tooltip', function () {
  const store = useStore(() => ({
    rootRef$: null
  }))
  const onActivate = this.props.onActivate

  useTask(({ track, cleanup }) => {
    const isOpen = track(() => this.props.open$?.())
    const anchorRef = this.props.anchorRef$?.()
    if (!isOpen || !anchorRef) return

    const el = store.rootRef$()
    if (!el) return

    // `after: 'rendering'` only applies to the first task run; on re-runs the
    // task fires before the DOM patch applies the `open` class, so the element
    // may still measure 0x0. Measure hidden, retry on the next frame, and let
    // a ResizeObserver reposition once the real layout lands.
    el.style.visibility = 'hidden'
    const place = () => {
      const anchorRect = anchorRef.getBoundingClientRect()
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const isLandscape = window.innerWidth > window.innerHeight
      const margin = 8
      let left
      let top
      if (isLandscape) {
        left = Math.max(margin, anchorRect.left - rect.width - margin)
        top = Math.max(margin, anchorRect.top - 2)
      } else {
        // Match the toolbar-menu fallback: in portrait the popover's left
        // edge aligns with the avatar's left edge and extends rightward.
        left = Math.max(margin, anchorRect.left)
        left = Math.min(left, window.innerWidth - rect.width - margin)
        top = Math.max(margin, anchorRect.top - rect.height - margin)
      }
      el.style.left = `${left}px`
      el.style.top = `${top}px`
      el.style.visibility = 'visible'
    }

    const frame = requestAnimationFrame(place)
    const resizeObserver = new ResizeObserver(place)
    resizeObserver.observe(el)
    window.addEventListener('resize', place)
    const orientation = window.matchMedia('(orientation: landscape)')
    orientation.addEventListener('change', place)
    cleanup(() => {
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      window.removeEventListener('resize', place)
      orientation.removeEventListener('change', place)
    })
  })

  return this.h`
    <style>${/* css */`
      signer-request-tooltip .signer-request-tooltip-root {
        position: fixed;
        z-index: 1000;
        display: none;
        min-width: 170px;
        max-width: 230px;
        padding: 10px 12px;
        border-radius: 8px;
        background-color: ${cssVars.colors.bg2};
        color: ${cssVars.colors.fg2};
        font-size: 13rem;
        line-height: 1.35;
        box-shadow: 0 4px 12px ${cssVars.colors.shadow};
        cursor: pointer;
      }

      signer-request-tooltip .signer-request-tooltip-root.open {
        display: block;
      }

      signer-request-tooltip .signer-request-tooltip-arrow {
        position: absolute;
        width: 8px;
        height: 8px;
        background-color: ${cssVars.colors.bg2};
        transform: rotate(45deg);

        @media (orientation: portrait) {
          top: calc(100% - 4px);
          left: 16px;
        }
        @media (orientation: landscape) {
          top: 10px;
          left: calc(100% - 4px);
        }
      }

      signer-request-tooltip .signer-request-tooltip-border {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }

      signer-request-tooltip .signer-request-tooltip-border rect {
        fill: none;
        stroke: ${cssVars.colors.bgAccentPrimary};
        stroke-width: 1.5px;
        vector-effect: non-scaling-stroke;
        stroke-dasharray: 25 75;
        animation: signerRequestTooltipBorder 2.4s linear infinite;
      }

      @keyframes signerRequestTooltipBorder {
        to {
          stroke-dashoffset: -100;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        signer-request-tooltip .signer-request-tooltip-border rect {
          animation: none;
          stroke-dasharray: none;
        }
      }
    `}</style>
    <div
      id="signer-request-tooltip"
      ref=${store.rootRef$}
      class=${{
        'signer-request-tooltip-root': true,
        open: this.props.open$?.() ?? false
      }}
      role="button"
      tabindex="0"
      onclick=${() => onActivate?.()}
      onkeydown=${e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onActivate?.()
        }
      }}
    >
      <div class="signer-request-tooltip-arrow"></div>
      <svg
        class="signer-request-tooltip-border"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect x="1" y="1" width="98" height="98" rx="8" pathLength="100" />
      </svg>
      <span>${this.props.text$?.() ?? ''}</span>
    </div>
  `
})
