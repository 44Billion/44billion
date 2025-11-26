import { f } from '#f'
import useGoBackOrToRoot from '#hooks/use-go-back-or-to-root.js'
import '#shared/icons/icon-chevron-left.js'

f('back-btn', function () {
  const goBackOrToRoot = useGoBackOrToRoot()
  return this.h`
    <button onclick=${goBackOrToRoot}>
      <icon-chevron-left props=${{ size: '26px' }} />
    </button>
  `
})
