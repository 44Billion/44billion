import { f, useStore } from '#f'
import '#shared/svg.js'

f('icon-check', function () {
  // https://tabler.io/icons/icon/check
  const store = useStore({
    path$: [
      'M5 12l5 5l10 -10'
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
