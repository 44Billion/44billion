import { f, useStore } from '#f'
import '#shared/svg.js'

f('iconReload', function () {
  // https://tabler.io/icons/icon/reload
  const store = useStore({
    path$: [
      'M19.933 13.041a8 8 0 1 1 -9.925 -8.788c3.899 -1 7.935 1.007 9.425 4.747',
      'M20 4v5h-5'
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
