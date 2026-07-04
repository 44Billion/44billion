import { f, useGlobalStore, useTask } from '#f'
import AppUpdater from '#services/app-updater/index.js'
import { formatAssetBudgetBytes } from '#services/app-asset-budget/index.js'
import useLocation from '#hooks/use-location.js'
import router from './router.js'
import '#zones/screen/index.js'
import { useVaultModalStore } from '#zones/vault-modal/index.js'
import '#zones/permission-dialog/index.js'
import '#zones/confirmation-dialog/index.js'
import '#zones/file-not-cached-dialog/index.js'

f('multi-napp', function () {
  const { requestConfirmation } = useGlobalStore('<confirmation-dialog>')

  useTask(({ cleanup }) => {
    const requestAssetBudgetConfirmation = ({ nextApprovedBytes, filename }) => requestConfirmation({
      title: 'More app storage?',
      message: `${filename ? `${filename} needs` : 'An app update needs'} more cached storage. Allow this app's assets up to ${formatAssetBudgetBytes(nextApprovedBytes)}?`,
      confirmText: `Allow ${formatAssetBudgetBytes(nextApprovedBytes)}`
    })

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
