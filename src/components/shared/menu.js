import { f, useStore, useTask } from '#f'
import '#shared/pointerup-interceptor.js'

f('aMenu', function () {
  const store = useStore({
    // id is needed for styling while Firefox doesn't support @scope
    id$: this.props.id$ || this.props.id || ('a' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)),
    dialogRef$: null,
    render: this.props.render, // instead of <slot>
    shouldAlwaysDisplay$: this.props.shouldAlwaysDisplay$ ?? this.props.shouldAlwaysDisplay ?? false,
    isOpen$: this.props.isOpen$,
    close: this.props.close,
    afterClose: this.props.afterClose,
    // e.g. `& {
    //   position-anchor: --fsjhdfojfd; /* need to add same value to anchor's anchor-name css property */
    //   position-area: top span-right; /* https://anchor-tool.com/ */
    // }`
    style$: this.props.style$ ?? this.props.style ?? '',
    anchorRef$: this.props.anchorRef$, // Reference to anchor element for fallback positioning
    fallbackPositioningStyle$: '',
    fallbackOffset$: this.props.fallbackOffset ?? {}
  })
  const interceptorProps = useStore(() => ({
    isOpen$: store.isOpen$,
    isOpenedByLongPress: this.props.isOpenedByLongPress ?? false
  }))

  // Fallback positioning for browsers that don't support CSS anchor positioning
  useTask(({ track, cleanup }) => {
    track(() => this.props.contentKey$?.())
    // Optional geometry key and placement preference for widget menus.
    // Other menus retain their landscape/portrait positioning policy.
    track(() => this.props.positionKey$?.())
    const preferredPlacement = track(() => this.props.preferredPlacement$?.())
    const isOpen = track(() => store.isOpen$.get())
    const anchorRef = track(() => store.anchorRef$())
    if (!isOpen || !anchorRef || CSS.supports('position-anchor', '--test')) return

    store.fallbackPositioningStyle$(`
      & {
        visibility: hidden;
      }
    `) // reset position and hide before moving
    // Wait a bit to ensure dialog is shown and has dimensions
    let frame
    const position = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const anchorRect = anchorRef.getBoundingClientRect()
        const dialogRect = store.dialogRef$().getBoundingClientRect()
        const isLandscape = window.innerWidth > window.innerHeight

        // Consistent margin between menu and anchor
        const margin = 6
        let left
        let top
        // Position the menu relative to the anchor with consistent logic
        if (preferredPlacement === 'top-start') {
          const above = anchorRect.top - dialogRect.height - margin
          const below = anchorRect.bottom + margin
          const start = anchorRect.left
          const end = anchorRect.right - dialogRect.width
          const candidates = [
            { left: start, top: above }, { left: end, top: above },
            { left: start, top: below }, { left: end, top: below }
          ]
          const fits = ({ left, top }) => left >= margin && top >= margin &&
            left + dialogRect.width <= innerWidth - margin && top + dialogRect.height <= innerHeight - margin
          const visibleArea = ({ left, top }) =>
            Math.max(0, Math.min(left + dialogRect.width, innerWidth - margin) - Math.max(left, margin)) *
            Math.max(0, Math.min(top + dialogRect.height, innerHeight - margin) - Math.max(top, margin))
          // Mirror the native anchor order, then clamp the most visible option
          // if none fits in full. Existing consumers keep their original policy.
          const selected = candidates.find(fits) ?? candidates.reduce((best, next) => visibleArea(next) > visibleArea(best) ? next : best)
          ;({ left, top } = selected)
        } else if (isLandscape) {
          // Position to the left of the anchor with margin
          left = Math.max(margin, anchorRect.left - dialogRect.width - margin)
          top = anchorRect.top
        } else {
          // Position above the anchor with margin
          left = anchorRect.left
          const menuHeight = dialogRect.height > 0 ? dialogRect.height : 100 // fallback height
          top = Math.max(margin, anchorRect.top - menuHeight - margin)
        }

        const fallbackOffset = store.fallbackOffset$()
        const offset = (isLandscape ? fallbackOffset.landscape : fallbackOffset.portrait) || {}
        left += (offset.x || 0)
        top += (offset.y || 0)
        if (this.props.constrainToViewport) {
          left = Math.max(margin, Math.min(left, window.innerWidth - dialogRect.width - margin))
          top = Math.max(margin, Math.min(top, window.innerHeight - dialogRect.height - margin))
        }

        if (preferredPlacement === 'top-start') {
          // Insets address the margin box; candidates describe the visible box.
          const style = getComputedStyle(store.dialogRef$())
          left -= parseFloat(style.marginLeft) || 0
          top -= parseFloat(style.marginTop) || 0
        }
        store.fallbackPositioningStyle$(`
          & {
            left: ${left}px;
            top: ${top}px;
            right: auto;
            bottom: auto;
          }
        `)
      })
    }
    const observer = new ResizeObserver(position)
    const timer = setTimeout(() => {
      position()
      observer.observe(store.dialogRef$())
      if (preferredPlacement) observer.observe(anchorRef)
    }, 100) // or else dialogRect.height may be 0
    if (this.props.constrainToViewport) {
      window.addEventListener('resize', position)
      window.addEventListener('scroll', position, true)
    }
    cleanup(() => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      observer.disconnect()
      clearTimeout(timer)
      cancelAnimationFrame(frame)
    })
  }, { after: 'rendering' })

  useTask(({ track }) => {
    const isOpen = track(() => store.isOpen$.get())
    if (isOpen) store.dialogRef$().showPopover() // instead of .showModal()
    else store.dialogRef$().hidePopover() // instead of .close()
  }, { after: 'rendering' })

  // Clicks inside an app iframe (often cross-origin) never reach this
  // document, so the popover's native light-dismiss never fires. When the
  // iframe takes focus the top window blurs, so use that as the fallback
  // signal to close the menu.
  useTask(({ track, cleanup }) => {
    if (!track(() => store.isOpen$.get())) return
    const onWindowBlur = () => store.close()
    window.addEventListener('blur', onWindowBlur)
    cleanup(() => window.removeEventListener('blur', onWindowBlur))
  })

  // Keep initial focus on the menu, even when reopening with existing buttons.
  // Tab can still move focus into its actions. The dialog supplies the role.
  return this.h`
    <dialog
      id=${store.id$()}
      ref=${store.dialogRef$}
      data-name='menu'
      autofocus
      popover
      ontoggle=${e => {
        if (e.newState !== 'closed' || !store.isOpen$()) return
        store.close() // popover may close by light-dismiss (ESC or backdrop click)
      }}
      class="scope_f8d73h"
    >
      <style>${`
        .scope_f8d73h {
          & {
            container-type: normal;
            --duration: .3s;
            /* display: none; (default) */
            transition:
              overlay var(--duration) ease-in-out allow-discrete,
              display var(--duration) ease-in-out allow-discrete;
            position-area: top center;
            /* reset [popover] */
            &:focus-visible { outline: 0; }
            color: initial;
            background-color: initial;
            padding: 0;
            border: 0;
            inset: initial;
            width: initial;
            height: initial;
            overflow: initial;
            /* reset [dialog] */
            inset-inline-start: initial;
            inset-inline-end: initial;
          }

          &:popover-open, /* &[open] */ /* after dialog.showPopover() */ {
          }

          &:popover-open::backdrop /* &[open]::backdrop */ {
            backdrop-filter: blur(1px);

            @starting-style {
              backdrop-filter: blur(0px);
            }
          }

          &::backdrop {
            /* display: none; (default) */
            backdrop-filter: blur(0px);
            transition:
              backdrop-filter var(--duration) ease-in-out,
              overlay var(--duration) ease-in-out allow-discrete;
          }

          &#${store.id$()} {
            ${store.fallbackPositioningStyle$()}
            ${store.style$()}
          }
        }
      `}</style>
      ${(store.shouldAlwaysDisplay$.get() || store.isOpen$.get() || '') && (store.render?.call(this) ?? '')}
      <pointerup-interceptor props=${interceptorProps} />
    </dialog>
  `
})
