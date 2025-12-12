import { f, useStore } from '#f'
import '#shared/svg.js'

f('icon-dots', function () {
  // https://tabler.io/icons/icon/dots
  const store = useStore({
    path$: [
      'M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
      'M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
      'M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'
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
