import { f, useComputed, useStore, useTask } from '#f'
import '#f/components/f-slot.js'
import '#shared/icons/icon-x.js'
import { cssVars } from '#assets/styles/theme.js'

let nextDialogId = 0

// Copied from thenameisf's experimental fui-dialog and adapted as a local,
// stable launcher component. Public state remains signal-based.
f('a-dialog', ({ h, props }) => {
  const s = useStore(() => ({
    fallbackOpen$: false,
    fallbackText$: '',
    fallbackFlag$: false,
    fallbackDrawerPosition$: '',
    fallbackStyle$: '',
    renderedOpen$: false,
    renderedDrawerPosition$: '',
    containerRef$: null,
    previouslyFocused$: null,
    id: `a-dialog-${++nextDialogId}`
  }))

  const open$ = props.open$ ?? s.fallbackOpen$
  const heading$ = props.heading$ ?? s.fallbackText$
  const description$ = props.description$ ?? s.fallbackText$
  const noCloseOnEscape$ = props.noCloseOnEscape$ ?? s.fallbackFlag$
  const noCloseOnBackdrop$ = props.noCloseOnBackdrop$ ?? s.fallbackFlag$
  const showCloseButton$ = props.showCloseButton$ ?? s.fallbackFlag$
  const drawerPosition$ = props.drawerPosition$ ?? s.fallbackDrawerPosition$
  const closeLabel$ = props.closeLabel$ ?? s.fallbackText$
  const style$ = props.style$ ?? s.fallbackStyle$

  // Drawer position and open state can change in separate reactive passes.
  // Paint the closed drawer at its new edge before enabling its transition so
  // a previous edge cannot leak into the next opening animation.
  useTask(({ track, cleanup }) => {
    const [open, drawerPosition] = track(() => [
      open$(),
      drawerPosition$() || ''
    ])

    s.renderedDrawerPosition$(drawerPosition)
    const prefersReducedMotion =
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!drawerPosition || prefersReducedMotion) {
      s.renderedOpen$(open)
      return
    }

    s.renderedOpen$(false)
    if (!open) return

    let secondFrame
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (open$() && (drawerPosition$() || '') === drawerPosition) {
          s.renderedOpen$(true)
        }
      })
    })
    cleanup(() => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame)
    })
  })

  const close = kind => {
    if (kind === 'cancel') props.onDialogCancel?.()
    else props.onDialogClose?.()
    open$(false)
  }

  useTask(({ track, cleanup }) => {
    const open = track(() => open$())
    if (!open) return

    props.onDialogOpen?.()
    s.previouslyFocused$(document.activeElement)

    const body = document.body
    const currentCount = parseInt(body.getAttribute('data-a-dialog-count') || '0', 10)
    if (currentCount === 0) {
      body.setAttribute('data-a-dialog-original-overflow', body.style.overflow || '')
      body.setAttribute(
        'data-a-dialog-original-padding-inline-end',
        body.style.paddingInlineEnd || ''
      )

      const scrollbarWidth = Math.max(
        0,
        window.innerWidth - document.documentElement.clientWidth
      )
      const paddingInlineEnd =
        parseFloat(window.getComputedStyle(body).paddingInlineEnd) || 0

      body.style.overflow = 'hidden'
      if (scrollbarWidth > 0) {
        body.style.paddingInlineEnd = `${paddingInlineEnd + scrollbarWidth}px`
      }
    }
    body.setAttribute('data-a-dialog-count', String(currentCount + 1))

    const onKeydown = event => {
      if (event.key === 'Escape' && !noCloseOnEscape$()) {
        event.preventDefault()
        close('cancel')
        return
      }
      if (event.key !== 'Tab') return

      const container = s.containerRef$()
      if (!container) return
      const focusables = container.querySelectorAll(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeydown)

    cleanup(() => {
      document.removeEventListener('keydown', onKeydown)

      const newCount = Math.max(
        0,
        parseInt(body.getAttribute('data-a-dialog-count') || '0', 10) - 1
      )
      body.setAttribute('data-a-dialog-count', String(newCount))
      if (newCount === 0) {
        body.style.overflow = body.getAttribute('data-a-dialog-original-overflow') || ''
        body.style.paddingInlineEnd =
          body.getAttribute('data-a-dialog-original-padding-inline-end') || ''
        body.removeAttribute('data-a-dialog-original-overflow')
        body.removeAttribute('data-a-dialog-original-padding-inline-end')
        body.removeAttribute('data-a-dialog-count')
      }

      const previouslyFocused = s.previouslyFocused$()
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus()
      }
    })
  })

  useTask(({ track }) => {
    if (!track(() => open$())) return
    const container = s.containerRef$()
    if (!container) return
    const firstFocusable = container.querySelector(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    ;(firstFocusable ?? container).focus()
  }, { after: 'rendering' })

  const onBackdropClick = event => {
    if (noCloseOnBackdrop$()) return
    const container = s.containerRef$()
    if (container && !container.contains(event.target)) close('cancel')
  }

  const onCloseButtonClick = event => {
    event.stopPropagation()
    close('close')
  }

  const headingId = `${s.id}-heading`
  const descriptionId = `${s.id}-description`
  const headerFallback$ = useComputed(() =>
    heading$()
      ? h`<h2 id=${headingId} class="a-dialog__heading">${heading$()}</h2>`
      : h``
  )

  return h`
    <div
      class='scope_a_dialog'
      style=${style$()}
      data-open=${s.renderedOpen$() ? 'true' : 'false'}
      data-drawer-position=${s.renderedDrawerPosition$()}
    >
      <style>${/* css */`
        .scope_a_dialog {
          & {
            display: block;
            visibility: hidden;
            position: fixed;
            inset: 0;
            width: 100%;
            height: 100%;
            z-index: var(--a-dialog-z-index, 1000);
          }

          &[data-open='true'] {
            visibility: visible;
          }

          & .a-dialog__backdrop {
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background-color: ${cssVars.colors.modalBackdrop};
            opacity: 0;
            transition: opacity var(--a-dialog-motion-fast, 0.2s) ease;
          }

          &[data-open='true'] .a-dialog__backdrop {
            opacity: 1;
          }

          & .a-dialog__container {
            position: relative;
            max-inline-size: 90dvw;
            max-block-size: 90dvh;
            margin: 16px;
            opacity: 0;
            transform: translateY(10%);
            transition:
              opacity var(--a-dialog-motion-fast, 0.2s) ease,
              transform var(--a-dialog-motion-slow, 0.4s) ease var(--a-dialog-motion-fast, 0.2s);
          }

          &[data-open='true'] .a-dialog__container {
            opacity: 1;
            transform: translateY(0);
          }

          &:not([data-open='true'])[data-drawer-position='start'] .a-dialog__container,
          &:not([data-open='true'])[data-drawer-position='end'] .a-dialog__container,
          &:not([data-open='true'])[data-drawer-position='top'] .a-dialog__container,
          &:not([data-open='true'])[data-drawer-position='bottom'] .a-dialog__container {
            transition: none;
          }

          & .a-dialog__surface {
            box-sizing: border-box;
            overflow: auto;
            max-block-size: 90dvh;
            padding: var(--a-dialog-padding, 24px);
            color: var(--a-dialog-text, ${cssVars.colors.fg});
            background: var(--a-dialog-background, ${cssVars.colors.bg2Lighter});
            border: 1px solid var(--a-dialog-border-color, ${cssVars.colors.mg2});
            border-radius: var(--a-dialog-radius, 8px);
          }

          & .a-dialog__header {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
            margin-block-end: 16px;
          }

          & .a-dialog__heading {
            margin: 0;
            font-size: 18rem;
            font-weight: 600;
          }

          & .a-dialog__content {
            margin-block-end: 16px;
          }

          & .a-dialog__content:last-child {
            margin-block-end: 0;
          }

          & .a-dialog__content p {
            margin: 0 0 16px;
          }

          & .a-dialog__footer {
            margin-block-start: 16px;
          }

          & .a-dialog__footer:empty {
            margin-block-start: 0;
          }

          & f-slot {
            display: contents;
          }

          & .a-dialog__close {
            appearance: none;
            position: absolute;
            z-index: 1;
            inset-block-start: 12px;
            inset-inline-end: 12px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 40px;
            height: 40px;
            padding: 10px;
            border: 0;
            border-radius: 50%;
            color: var(--a-dialog-close-text, currentColor);
            background: var(--a-dialog-close-background, ${cssVars.colors.bg2Lighter});
            box-shadow: 0 2px 8px ${cssVars.colors.shadow};
            cursor: pointer;
          }

          & .a-dialog__close:focus-visible {
            outline: 2px solid var(--a-dialog-focus-ring, ${cssVars.colors.bgPrimary});
            outline-offset: 2px;
          }

          & .a-dialog__close icon-x,
          & .a-dialog__close a-svg {
            display: block;
            width: 100%;
            height: 100%;
          }

          &[data-drawer-position='start'] .a-dialog__container,
          &[data-drawer-position='end'] .a-dialog__container,
          &[data-drawer-position='top'] .a-dialog__container,
          &[data-drawer-position='bottom'] .a-dialog__container {
            box-sizing: border-box;
            position: fixed;
            margin: 0;
            max-inline-size: none;
            max-block-size: none;
          }

          &[data-drawer-position='start'] .a-dialog__container,
          &[data-drawer-position='end'] .a-dialog__container {
            inset-block: 0;
            width: var(--a-drawer-width, min(360px, calc(100dvw - 32px)));
            height: 100%;
          }

          &[data-drawer-position='top'] .a-dialog__container,
          &[data-drawer-position='bottom'] .a-dialog__container {
            inset-inline: 0;
            width: 100%;
            height: var(--a-drawer-height, 320px);
          }

          &[data-drawer-position='start'] .a-dialog__container {
            inset-inline-start: 0;
            transform: translateX(-100%);
          }

          &[data-drawer-position='end'] .a-dialog__container {
            inset-inline-end: 0;
            transform: translateX(100%);
          }

          &[data-drawer-position='top'] .a-dialog__container {
            inset-block-start: 0;
            transform: translateY(-100%);
          }

          &[data-drawer-position='bottom'] .a-dialog__container {
            inset-block-end: 0;
            transform: translateY(100%);
          }

          &[data-open='true'][data-drawer-position='start'] .a-dialog__container,
          &[data-open='true'][data-drawer-position='end'] .a-dialog__container,
          &[data-open='true'][data-drawer-position='top'] .a-dialog__container,
          &[data-open='true'][data-drawer-position='bottom'] .a-dialog__container {
            transform: none;
          }

          &[data-drawer-position='start'] .a-dialog__surface,
          &[data-drawer-position='end'] .a-dialog__surface,
          &[data-drawer-position='top'] .a-dialog__surface,
          &[data-drawer-position='bottom'] .a-dialog__surface {
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
            max-block-size: none;
            padding: 0;
            overflow: hidden;
            border-width: 0;
            border-radius: 0;
          }

          &[data-drawer-position='start'] .a-dialog__surface {
            border-right-width: 1px;
          }

          &[data-drawer-position='end'] .a-dialog__surface {
            border-left-width: 1px;
          }

          &[data-drawer-position='start'] .a-dialog__header,
          &[data-drawer-position='end'] .a-dialog__header,
          &[data-drawer-position='top'] .a-dialog__header,
          &[data-drawer-position='bottom'] .a-dialog__header,
          &[data-drawer-position='start'] .a-dialog__footer,
          &[data-drawer-position='end'] .a-dialog__footer,
          &[data-drawer-position='top'] .a-dialog__footer,
          &[data-drawer-position='bottom'] .a-dialog__footer {
            display: none;
          }

          &[data-drawer-position='start'] .a-dialog__content,
          &[data-drawer-position='end'] .a-dialog__content,
          &[data-drawer-position='top'] .a-dialog__content,
          &[data-drawer-position='bottom'] .a-dialog__content {
            flex: 1;
            min-height: 0;
            margin: 0;
            overflow: hidden;
          }

          &[data-drawer-position='start'] .a-dialog__close,
          &[data-drawer-position='end'] .a-dialog__close {
            inset-block-start: 0;
            width: 32px;
            height: 36px;
            padding: 4px;
            border-radius: 0;
            box-shadow: none;
            filter: drop-shadow(0 2px 4px ${cssVars.colors.shadow});
          }

          &[data-drawer-position='start'] .a-dialog__close:focus-visible,
          &[data-drawer-position='end'] .a-dialog__close:focus-visible {
            outline: 0;
            box-shadow: inset 0 0 0 2px var(--a-dialog-focus-ring, ${cssVars.colors.bgPrimary});
          }

          &[data-drawer-position='start'] .a-dialog__close {
            inset-inline-start: auto;
            inset-inline-end: -32px;
            clip-path: polygon(0 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%);
          }

          &[data-drawer-position='end'] .a-dialog__close {
            inset-inline-start: -32px;
            inset-inline-end: auto;
            clip-path: polygon(0 0, 100% 0, 100% 100%, 8px 100%, 0 calc(100% - 8px));
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .scope_a_dialog .a-dialog__backdrop,
          .scope_a_dialog .a-dialog__container {
            transition: none;
          }
        }
      `}</style>
      <div
        class="a-dialog__backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby=${heading$() ? headingId : null}
        aria-label=${heading$() ? null : 'Dialog'}
        aria-describedby=${description$() ? descriptionId : null}
        onclick=${onBackdropClick}
      >
        <div class="a-dialog__container" ref=${s.containerRef$} tabindex="-1">
          <div class="a-dialog__surface">
            <header class="a-dialog__header">
              <f-slot name="header" props=${{ fallback$: headerFallback$ }}></f-slot>
            </header>
            <div class="a-dialog__content">
              ${description$()
                ? h`<p id=${descriptionId}>${description$()}</p>`
                : h``}
              <f-slot></f-slot>
            </div>
            <footer class="a-dialog__footer">
              <f-slot name="footer"></f-slot>
            </footer>
          </div>
          ${showCloseButton$()
            ? h`
                <button
                  type="button"
                  class="a-dialog__close"
                  aria-label=${closeLabel$() || 'Close dialog'}
                  onclick=${onCloseButtonClick}
                >
                  <icon-x />
                </button>
              `
            : h``}
        </div>
      </div>
    </div>
  `
})
