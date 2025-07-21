import { f, useStore, useAsyncComputed } from '#f'
import { getSvgAvatar } from '#helpers/avatar.js'
import '#shared/icons/icon-user-circle.js'
import '#shared/svg.js'

// todo: if there's kind 0 picture, use it
f(function aAvatar () {
  const store = useStore({
    pk$: this.props.pk$ ?? this.props.pk,
    svg$: useAsyncComputed(() => {
      const seed = store.pk$()
      if (!seed) return
      return getSvgAvatar(seed)
    })
  })

  if (!store.pk$() || !store.svg$()) {
    return this.h`<icon-user-circle props=${this.props} />`
  }

  return this.h`<a-svg props=${{ ...this.props, svg: store.svg$() }} />`
})
