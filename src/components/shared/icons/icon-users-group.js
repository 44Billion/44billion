import { f, useStore } from '#f'
import 'thenameisf/components/f-svg.js'

f('icon-users-group', ({ h, props }) => {
  // https://tabler.io/icons/icon/users-group
  const store = useStore({
    path$: [
      'M10 13a2 2 0 1 0 4 0a2 2 0 0 0 -4 0',
      'M8 21v-1a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v1',
      'M15 5a2 2 0 1 0 4 0a2 2 0 0 0 -4 0',
      'M17 10h2a2 2 0 0 1 2 2v1',
      'M5 5a2 2 0 1 0 4 0a2 2 0 0 0 -4 0',
      'M3 13v-1a2 2 0 0 1 2 -2h2'
    ],
    viewBox$: '2 2 20 20'
  })
  return h`<f-svg props=${{ ...store, ...props }} />`
})
