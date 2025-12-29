import { f, useStore } from '#f'
import '#shared/svg.js'

f('icon-square-rounded-letter-n', function () {
  // https://tabler.io/icons/icon/square-rounded-letter-n
  const store = useStore({
    path$: [
      'M10 16v-8l4 8v-8',
      'M12 3c7.2 0 9 1.8 9 9s-1.8 9 -9 9s-9 -1.8 -9 -9s1.8 -9 9 -9z'
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
