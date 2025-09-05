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
    //   position-area: top span-right;
    // }`
    style$: this.props.style$ ?? this.props.style ?? ''
  })
  const interceptorProps = useStore(() => ({
    isOpen$: store.isOpen$,
    isOpenedByLongPress: this.props.isOpenedByLongPress ?? false
  }))

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

          &#${store.id$()} { ${store.style$()} }
        }
      `}</style>
      ${(store.shouldAlwaysDisplay$.get() || store.isOpen$.get() || '') && (store.render?.call(this) ?? '')}
      <pointerup-interceptor props=${interceptorProps} />
    </dialog>
  `
})
