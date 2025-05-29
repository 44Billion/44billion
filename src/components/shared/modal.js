import { f, useStore, useTask } from 'f'
import { jsVars } from '#assets/styles/theme.js'

export const Modal = f(function aModal () {
  const store = useStore({
    dialogRef$: null,
    render: this.props.render, // instead of <slot>
    shouldAlwaysDisplay$: this.props.shouldAlwaysDisplay$ ?? this.props.shouldAlwaysDisplay ?? false,
    isOpen$: this.props.isOpen$,
    close: this.props.close,
    afterClose: this.props.afterClose
  })

  useTask(({ track }) => {
    const isOpen = track(() => store.isOpen$.get())
    if (isOpen) store.dialogRef$().showModal()
    else store.dialogRef$().close()
  })

  // https://css-tricks.com/clarifying-the-relationship-between-popovers-and-dialogs
  // offtopic: video::backdrop is useful to style when fullscreen
  // https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog#transitioning_dialog_elements
  // https://developer.mozilla.org/en-US/docs/Web/CSS/@starting-style#examples
  // https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_transitions/Using_CSS_transitions#transitioning_display_and_content-visibility
  // https://developer.mozilla.org/en-US/docs/Web/CSS/:popover-open
  // https://developer.mozilla.org/en-US/docs/Web/API/Popover_API/Using#auto_state_and_light_dismiss
  // popover(=auto) attr on a dialog makes clicking on backdrop or pressing ESC close it (light dismiss)
  // i.e. no need for onkeydown=${store.onKeydown}
  return this.h`
    <dialog
      ref=${store.dialogRef$}
      data-name='modal'
      popover
      onclose=${store.close /* popover may close by light-dismiss (ESC or backdrop click) */}
    >
      <style>
        @scope {
          & /* &:modal are those opened with showModal() instead of show() */ {
            container-type: normal;
            --duration: .3s;
            /* display: none; (default) */
            overlay var(--duration) ease-in-out allow-discrete,
            display var(--duration) ease-in-out allow-discrete;
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

          /* &:popover-open, */ &[open] /* after dialog.showModal() */ {
            display: flex;
            position: fixed;
            inset: 0;
          }

          /* &:popover-open::backdrop, */ &[open]::backdrop {
            opacity: 0.6;
            backdrop-filter: blur(1px);

            @starting-style {
              opacity: 0;
              backdrop-filter: blur(0px);
            }
          }

          &::backdrop {
            /* display: none; (default) */
            opacity: 0;
            backdrop-filter: blur(0px);
            position: absolute;
            inset: 0;
            background-color: black;
            transition:
              opacity var(--duration) ease-in-out,
              backdrop-filter var(--duration) ease-in-out,
              overlay var(--duration) ease-in-out allow-discrete,
              display var(--duration) ease-in-out allow-discrete;
          }
        }
      </style>
      <div
        data-name='modalContentContainer'
        style=${`
          position: absolute;
          transition: var(--duration) ease-in-out;
          transition-property: top, transform;
          border-top-right-radius: 17px; /* for scrollbar */
          overflow: hidden; /* for scrollbar */
        `}
      >
        <style>
          ${`@scope {
            & {
              @media ${jsVars.breakpoints.desktop} {
                left: 50%;
                top: 100%;
                transform: translate(-50%, 0%);
                @container /* style(:popover-open), */ style([open]) {
                  top: 50%;
                  transform: translate(-50%, -50%);
                }
                border-bottom-right-radius: 17px; /* for scrollbar */
              }

              @media ${jsVars.breakpoints.mobile} {
                align-self: flex-end;
                transform: translate(0, 100%);
                @container /* style(:popover-open), */ style([open]) {
                  transform: translate(0, 0);
                }
              }
            }
          }`}
        </style>
        <div
          data-name='modalContent'
          style=${`
            overflow-y: auto;
            /*
              https://gist.github.com/adamcbrewer/5859738
              https://stackoverflow.com/questions/5736503/how-to-make-css3-rounded-corners-hide-overflow-in-chrome-opera
              the scroll without this ignores border-radius
              but it will blur content
              mask-image: -webkit-radial-gradient(circle, white, black);
            */

            display: flex;
            flex-direction: column;
            /* background-color: white; */
            min-height: 250px; /* when there is loading (dynamic content) */
          `}
        >
          <style>
            ${`@scope {
              & {
                @media ${jsVars.breakpoints.desktop} {
                  border-radius: 17px;
                  min-width: 400px;
                  width: 800px;
                  max-width: 90vw;
                  max-width: 90dvw;
                  max-height: 90vh; /* leave 10 for browser collapsible header */
                  max-height: 90dvh;
                }

                @media ${jsVars.breakpoints.mobile} {
                  border-top-left-radius: 17px;
                  border-top-right-radius: 17px;
                  width: 100vw;
                  width: 100dvw;
                  max-height: 85vh;
                  max-height: 85dvh;
                }
              }

              ${(store.shouldAlwaysDisplay$.get() || '') && `
                content-visibility: auto;
                contain-intrinsic-width: auto 400px;
                contain-intrinsic-height: auto 250px;
              `}
            }`}
          </style>
          ${(store.shouldAlwaysDisplay$.get() || store.isOpen$.get() || '') && (store.render?.call(this) ?? '')}
        </div>
      </div>
    </dialog>
  `
}, { useShadowDOM: false })
