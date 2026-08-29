import { f, useStore } from '#f'
import '#shared/svg.js'

f('iconGripVertical', function () {
  // https://tabler.io/icons/icon/grip-vertical
  const store = useStore({
    path$: [
      'M9 5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
      'M9 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
      'M9 19m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
      'M15 5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
      'M15 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
      'M15 19m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'
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
