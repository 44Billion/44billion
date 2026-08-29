import { f, useStore } from '#f'
import '#shared/svg.js'

f('iconPin', function () {
  // https://tabler.io/icons/icon/pin
  const store = useStore({
    path$: [
      'M12 17v5',
      'M9 4h6',
      'M10 4v6l-3 3v2h10v-2l-3-3V4'
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
