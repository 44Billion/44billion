import { f, useStore } from '#f'
import '#shared/svg.js'

f('icon-wash-dry-shade', function () {
  // https://tabler.io/icons/icon/wash-dry-shade
  const store = useStore({
    path$: [
      'M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12',
      'M3 11l8 -8',
      'M3 17l14 -14'
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
