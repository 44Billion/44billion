import { f, useStore } from '#f'
import '#shared/svg.js'

f('icon-arrow-narrow-right', function () {
  // https://tabler.io/icons/icon/check
  const store = useStore({
    path$: [
      'M5 12l14 0',
      'M15 16l4 -4',
      'M15 8l4 4'
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
