import { f, useSignal, useTask, useGlobalStore, useWebStorage } from '#f'
import { useVaultActor } from '#zones/vault-modal/index.js'
import { usePermissionDialogStore } from '#zones/permission-dialog/index.js'
import { useConfirmationDialogStore } from '#zones/confirmation-dialog/index.js'
import { nappletReferenceFromHref } from '#helpers/napplet.js'
import { loadNapplet } from '#services/napplets/index.js'
import { mountNapplet } from '#services/napplets/runtime.js'
import { getNappletIntentCoordinator } from '#services/napplets/intents.js'
import { chooseNappletIntent, nappletIntentHandoffs$, presentNappletNotice } from '#services/napplets/ui.js'
import { cssVars } from '#assets/styles/theme.js'
import { nappletT as t } from '#i18n/napplets.js'

f('napplet-frame', function () {
  const { askVault } = useVaultActor()
  const { requestPermission } = usePermissionDialogStore()
  const { requestConfirmation } = useConfirmationDialogStore()
  const { openApp, openIntentTarget, openNappletStore } = useGlobalStore('useAppRouter')
  const storage = useWebStorage(localStorage)
  const coordinator$ = useSignal(null)
  useTask(({ track }) => {
    const coordinator = track(() => {
      storage[`session_workspaceByKey_${this.props.wsKey}_pinnedAppIds$`]()
      storage[`session_workspaceByKey_${this.props.wsKey}_unpinnedAppIds$`]()
      storage.local_nappletIntentDefaults$()
      return coordinator$()
    })
    coordinator?.changed().catch(() => {})
  })
  const frame$ = useSignal(null)
  const error$ = useSignal('')
  const loading$ = useSignal(true)
  const revision$ = useSignal(0)
  useTask(async ({ track, cleanup }) => {
    const [frame, appId, userPk] = track(() => [frame$(), this.props.appId$(), this.props.userPk$(), revision$()])
    if (!frame || !appId || !userPk) return
    let disposed = false
    let unmount
    cleanup(() => { disposed = true; unmount?.() })
    error$('')
    loading$(true)
    try {
      const resolved = await loadNapplet(appId)
      if (disposed) return
      const intents = getNappletIntentCoordinator({
        wsKey: this.props.wsKey, userPk, storage: localStorage,
        openTarget: (target, behavior) => openIntentTarget(target, this.props.wsKey, behavior),
        choose: chooseNappletIntent,
        find: handoff => {
          nappletIntentHandoffs$(value => ({ ...value, [this.props.wsKey]: { ...handoff, userPk } }))
          openNappletStore(this.props.wsKey)
        },
        reportError: () => presentNappletNotice(t('Napplet'), { notificationId: 'intent-failure', message: { title: t('Could not open intent') } })
      })
      coordinator$(intents)
      unmount = mountNapplet({
        intents, appKey: this.props.appKey,
        iframe: frame, resolved, appId, userPk, wsKey: this.props.wsKey, askVault, requestPermission,
        openLink: async url => {
          await requestConfirmation({ title: t('Open link'), message: url.href, confirmText: t('Open') })
          if (url.origin === window.location.origin && nappletReferenceFromHref(url.href)) {
            await openApp(url.href, this.props.wsKey)
            return { status: 'opened' }
          }
          const opened = window.open(url.href, '_blank')
          if (opened) { opened.opener = null; return { status: 'opened' } }
          return { status: 'denied', error: 'popup-blocked' }
        }
      })
    } catch (error) { if (!disposed) error$(error.message) } finally { if (!disposed) loading$(false) }
  }, { after: 'rendering' })
  return this.h`
    <style>${/* css */`
      napplet-frame {
        display: block !important; position: relative; width: 100%; height: 100%;
        iframe { width: 100%; height: 100%; border: 0; }
        .status { position: absolute; inset: 0; padding: 16px; background: ${cssVars.colors.bg}; color: ${cssVars.colors.fg}; font-size: 14rem; }
      }
    `}</style>
    <iframe title=${t('Napplet')} sandbox='allow-scripts' ref=${frame$}></iframe>
    ${error$() ? this.h`<div class='status' role='alert'>${error$()} <button onclick=${() => revision$(n => n + 1)}>${t('Retry')}</button></div>` : loading$() ? this.h`<div class='status' role='status'>${t('Opening napplet…')}</div>` : ''}
  `
})
