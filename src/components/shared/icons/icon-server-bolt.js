import { f, useStore } from '#f'
import 'thenameisf/components/f-svg.js'

f('icon-server-bolt', ({ h, props }) => {
  // https://tabler.io/icons/icon/server-bolt
  const store = useStore(() => ({
    path$: [
      'M3 7a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-2',
      'M15 20h-9a3 3 0 0 1 -3 -3v-2a3 3 0 0 1 3 -3h12',
      'M7 8v.01',
      'M7 16v.01',
      'M20 15l-2 3h3l-2 3'
    ],
    viewBox$: '2 2 20 20'
  }))
  return h`<f-svg props=${{ ...store, ...props }} />`
})
