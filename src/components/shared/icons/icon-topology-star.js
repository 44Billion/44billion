import { f, useStore } from '#f'
import 'thenameisf/components/f-svg.js'

f('icon-topology-star', ({ h, props }) => {
  // https://tabler.io/icons/icon/topology-star
  const store = useStore({
    path$: [
      'M8 18a2 2 0 1 0 -4 0a2 2 0 0 0 4 0',
      'M20 6a2 2 0 1 0 -4 0a2 2 0 0 0 4 0',
      'M8 6a2 2 0 1 0 -4 0a2 2 0 0 0 4 0',
      'M20 18a2 2 0 1 0 -4 0a2 2 0 0 0 4 0',
      'M14 12a2 2 0 1 0 -4 0a2 2 0 0 0 4 0',
      'M7.5 7.5l3 3',
      'M7.5 16.5l3 -3',
      'M13.5 13.5l3 3',
      'M16.5 7.5l-3 3'
    ],
    viewBox$: '2 2 20 20'
  })
  return h`<f-svg props=${{ ...store, ...props }} />`
})
