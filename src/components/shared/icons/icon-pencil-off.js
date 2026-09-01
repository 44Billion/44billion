import { f, useStore } from '#f'
import 'thenameisf/components/f-svg.js'

f('icon-pencil-off', function () {
  // https://tabler.io/icons/icon/pencil-off
  const store = useStore({
    path$: [
      'M10 10l-6 6v4h4l6 -6m1.99 -1.99l2.504 -2.504a2.828 2.828 0 1 0 -4 -4l-2.5 2.5',
      'M3 3l18 18'
    ],
    viewBox$: '2 2 20 20'
  })

  return this.h`<f-svg
    props=${{
      ...store,
      ...this.props
    }}
  />`
})
