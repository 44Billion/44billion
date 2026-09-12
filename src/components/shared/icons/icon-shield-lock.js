import { f, useStore } from '#f'
import 'thenameisf/components/f-svg.js'

f('icon-shield-lock', ({ h, props }) => {
  // https://tabler.io/icons/icon/shield-lock
  const store = useStore(() => ({
    path$: [
      'M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3',
      'M11 11a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
      'M12 12l0 2.5'
    ],
    viewBox$: '2 2 20 20'
  }))
  return h`<f-svg props=${{ ...store, ...props }} />`
})
