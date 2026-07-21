import { f, useTask } from '#f'
import AppUpdater from '#services/app-updater/index.js'
import { formatAssetBudgetBytes } from '#services/app-asset-budget/index.js'
import useLocation from '#hooks/use-location.js'
import router from './router.js'
import '#zones/screen/index.js'
import { useVaultModalStore } from '#zones/vault-modal/index.js'
import '#zones/permission-dialog/index.js'
import { useConfirmationDialogStore } from '#zones/confirmation-dialog/index.js'
import { getAssetBudgetConfirmation } from '#i18n/asset-budget.js'
import '#zones/file-not-cached-dialog/index.js'

f('multi-napp', function () {
  const { requestConfirmation } = useConfirmationDialogStore()

  useTask(({ cleanup }) => {
    const requestAssetBudgetConfirmation = details => requestConfirmation(getAssetBudgetConfirmation({
      ...details,
      subject: 'update',
      formatBytes: formatAssetBudgetBytes
    }))

    AppUpdater.initCleanupJob()
    AppUpdater.initUpdateCheckJob({
      requestAssetBudgetConfirmation
    })
    cleanup(AppUpdater.initDraftUpdateWatchJob({ requestAssetBudgetConfirmation }))
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
    <file-not-cached-dialog />
    <a-screen />
  `
})
