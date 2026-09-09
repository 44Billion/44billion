import { f, useStore } from '#f'
import 'thenameisf/components/f-svg.js'

f('icon-restore', ({ h, props }) => {
  // https://tabler.io/icons/icon/restore
  const store = useStore({
    path$: [
      'M3.06 13a9 9 0 1 0 .49 -4.087',
      'M3 4.001v5h5',
      'M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'
    ],
    viewBox$: '2 2 20 20'
  })
  return h`<f-svg props=${{ ...store, ...props }} />`
})
