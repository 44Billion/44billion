import { f } from '#f'
import useLocation from '#hooks/use-location.js'
import router from './router.js'
import '#zones/screen/index.js'
import { useVaultModalStore } from '#zones/vault-modal/index.js'

f(function multiNapp () {
  useLocation(router)
  useVaultModalStore(() => ({
    isOpen$: false,
    open () { this.isOpen$(true) },
    close () { this.isOpen$(false) }
  }))

  return this.h`
    <vault-modal />
    <a-screen />
  `
})
