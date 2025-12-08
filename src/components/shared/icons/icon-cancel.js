import { f, useStore } from '#f'
import '#shared/svg.js'

f('icon-cancel', function () {
  // https://tabler.io/icons/icon/cancel
  const store = useStore({
    path$: [
      'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0',
      'M18.364 5.636l-12.728 12.728'
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
