import { f, useStore } from '#f'
import 'thenameisf/components/f-svg.js'

f('icon-database', ({ h, props }) => {
  // https://tabler.io/icons/icon/database
  const store = useStore(() => ({
    path$: [
      'M4 6a8 3 0 1 0 16 0a8 3 0 1 0 -16 0',
      'M4 6v6a8 3 0 0 0 16 0v-6',
      'M4 12v6a8 3 0 0 0 16 0v-6'
    ],
    viewBox$: '2 2 20 20'
  }))
  return h`<f-svg props=${{ ...store, ...props }} />`
})
