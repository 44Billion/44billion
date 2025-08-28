import { f, useStore, useTask } from '#f'

f(function aMenu () {
  const store = useStore({
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

  useTask(({ track }) => {
    const isOpen = track(() => store.isOpen$.get())
    if (isOpen) store.dialogRef$().show() // instead of showModal
    else store.dialogRef$().close()
  })

  return this.h`
    <dialog
      ref=${store.dialogRef$}
      data-name='menu'
      popover
      onclose=${store.close /* popover may close by light-dismiss (ESC or backdrop click) */}
      class="scope_f8d73h"
    >
      <style>${`
        .scope_f8d73h {
          & {
            container-type: normal;
            --duration: .3s;
            /* display: none; (default) */
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

          /* &:popover-open, */ &[open] /* after dialog.show() */ {
            display: flex;
            position: fixed;
          }

          /* &:popover-open::backdrop, */ &[open]::backdrop {
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

          ${store.style$()}
        }
      `}</style>
      ${(store.shouldAlwaysDisplay$.get() || store.isOpen$.get() || '') && (store.render?.call(this) ?? '')}
    </div>
  `
})
