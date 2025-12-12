import { f, useStore } from '#f'
import '#shared/svg.js'

f('icon-eye-closed', function () {
  // https://tabler.io/icons/icon/eye-closed
  const store = useStore({
    path$: [
      'M21 9c-2.4 2.667 -5.4 4 -9 4c-3.6 0 -6.6 -1.333 -9 -4',
      'M3 15l2.5 -3.8',
      'M21 14.976l-2.492 -3.776',
      'M9 17l.5 -4',
      'M15 17l-.5 -4'
    ],
    viewBox$: '2 2 20 20'
  })

  return this.h`<a-svg
    props=${{
      ...store,
      ...this.props
    }}
  />`
})
