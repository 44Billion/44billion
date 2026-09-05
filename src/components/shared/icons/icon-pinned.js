import { f, useStore } from '#f'
import 'thenameisf/components/f-svg.js'

// https://github.com/tabler/tabler-icons/blob/main/icons/outline/pinned.svg
f('icon-pinned', ({ h, props }) => {
  const store = useStore({
    path$: ['M9 4v6l-2 4v2h10v-2l-2 -4v-6', 'M12 16l0 5', 'M8 4l8 0'],
    viewBox$: '2 2 20 20'
  })
  return h`<f-svg props=${{ ...store, ...props }} />`
})
