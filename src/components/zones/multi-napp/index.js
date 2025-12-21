import { f, useTask } from '#f'
import AppUpdater from '#services/app-updater/index.js'
import useLocation from '#hooks/use-location.js'
import router from './router.js'
import '#zones/screen/index.js'
import { useVaultModalStore } from '#zones/vault-modal/index.js'
import '#zones/permission-dialog/index.js'
import '#zones/confirmation-dialog/index.js'

f('multi-napp', function () {
  useTask(() => {
    AppUpdater.initCleanupJob()
    AppUpdater.initUpdateCheckJob()
  })

  useLocation(router)
  useVaultModalStore(() => ({
    isOpen$: false,
    open () { this.isOpen$(true) },
    close () { this.isOpen$(false) }
  }))

  return this.h`
    <vault-modal />
    <permission-dialog />
    <confirmation-dialog />
    <a-screen />
  `
})
