import { f, useStore } from '#f'
import 'thenameisf/components/f-svg.js'

f('icon-users-plus', ({ h, props }) => {
  // https://tabler.io/icons/icon/users-plus
  const store = useStore({
    path$: [
      'M5 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0',
      'M3 21v-2a4 4 0 0 1 4 -4h4c.96 0 1.84 .338 2.53 .901',
      'M16 3.13a4 4 0 0 1 0 7.75',
      'M16 19h6',
      'M19 16v6'
    ],
    viewBox$: '2 2 21 21'
  })
  return h`<f-svg props=${{ ...store, ...props }} />`
})
