import { f, useStore, useTask } from '#f'

f(function pointerupInterceptor () {
  const { props: { isOpen$, isOpenedByLongPress } } = this
  if (!isOpenedByLongPress) return

  const store = useStore(() => ({
    isFirstRun$: true,
    dialogRef$: null,
    shouldOpen$ () {
      const isOpen = isOpen$()
      if (this.isFirstRun$.get(false)) { this.isFirstRun$.set(false); return false }
      return isOpen
    },
    onPointerUp () { requestIdleCallback(() => this.dialogRef$().hidePopover()) }
  }))
  useTask(({ track }) => {
    if (!track(() => store.shouldOpen$())) return
    store.dialogRef$().showPopover()
  }, { after: 'rendering' })

  // The popover attr makes it be on browser's top-layer
  // This component should be placed as a nested popover
  // https://developer.mozilla.org/en-US/docs/Web/API/Popover_API/Using#nested_popovers
  return this.h`<div
    popover
    ref=${store.dialogRef$}
    onpointerup=${store.onPointerUp}
    style=${`
      background-color: transparent;
      border: none;
      padding: 0;
      margin: 0;
      width: 100%;
      height: 100%;
    `}
  />`
})
