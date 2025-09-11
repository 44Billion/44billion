import { f, useStore, useTask } from '#f'
import '#shared/pointerup-interceptor.js'

f(function aMenu () {
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
    fallbackPositioningStyle$: ''
  })
  const interceptorProps = useStore(() => ({
    isOpen$: store.isOpen$,
    isOpenedByLongPress: this.props.isOpenedByLongPress ?? false
  }))

  // Fallback positioning for browsers that don't support CSS anchor positioning
  useTask(({ track }) => {
    const isOpen = track(() => store.isOpen$.get())
    const anchorRef = track(() => store.anchorRef$())
    if (!isOpen || !anchorRef || CSS.supports('position-anchor', '--test')) return

    store.fallbackPositioningStyle$(`
      & {
        visibility: hidden;
      }
    `) // reset position and hide before moving
    // Wait a bit to ensure dialog is shown and has dimensions
    setTimeout(() => {
      requestAnimationFrame(() => {
        const anchorRect = anchorRef.getBoundingClientRect()
        const dialogRect = store.dialogRef$().getBoundingClientRect()
        const isLandscape = window.innerWidth > window.innerHeight
        console.log('anchorRect', anchorRect, 'dialogRect', dialogRect, 'isLandscape', isLandscape)

        // Consistent margin between menu and anchor
        const margin = 6
        let left
        let top
        // Position the menu relative to the anchor with consistent logic
        if (isLandscape) {
          // Position to the left of the anchor with margin
          left = Math.max(margin, anchorRect.left - dialogRect.width - margin)
          top = anchorRect.top
        } else {
          // Position above the anchor with margin
          left = anchorRect.left
          const menuHeight = dialogRect.height > 0 ? dialogRect.height : 100 // fallback height
          top = Math.max(margin, anchorRect.top - menuHeight - margin)
        }
        console.log('Positioning left with', { left, top })
        store.fallbackPositioningStyle$(`
          & {
            left: ${left}px;
            top: ${top}px;
            right: auto;
            bottom: auto;
          }
        `)
      })
    }, 50) // or else dialogRect.height may be 0
  }, { after: 'rendering' })

  useTask(({ track }) => {
    const isOpen = track(() => store.isOpen$.get())
    if (isOpen) store.dialogRef$().showPopover() // instead of .showModal()
    else store.dialogRef$().hidePopover() // instead of .close()
  }, { after: 'rendering' })

  // The dialog tag gives us a dialog role for free
  return this.h`
    <dialog
      id=${store.id$()}
      ref=${store.dialogRef$}
      data-name='menu'
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
            display: flex;
            position: fixed;
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
