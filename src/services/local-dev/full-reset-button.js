import { f, useGlobalStore } from '#f'
import { useConfirmationDialogStore } from '#zones/confirmation-dialog/index.js'
import { useVaultActor, useVaultMessengerStore } from '#zones/vault-modal/index.js'
import { useInfoDialogStore } from '#zones/info-dialog/index.js'
import { getT, SUPPORTED_LOCALES } from '#i18n/index.js'
import { cssVars } from '#assets/styles/theme.js'
import '#shared/icons/icon-database.js'
import { isLocalDevApp } from './state.js'
import { requestLocalDevFullReset } from './full-reset.js'

const en = {
  reset: 'Reset development environment and reload',
  confirm: 'Reset environment',
  errorTitle: 'Development reset',
  message: 'Delete every account in the vault and all local data of every app in this browser? ' +
    'The launcher and the vault are cleared, other tabs reload, installed files are restored by the watcher. ' +
    'Development only.',
  failed: 'Could not clear the vault. Check that it is reachable and try again.'
}
const pt = {
  reset: 'Redefinir ambiente de desenvolvimento e recarregar',
  confirm: 'Redefinir ambiente',
  errorTitle: 'Redefinição de desenvolvimento',
  message: 'Apagar todas as contas do vault e todos os dados locais de todos os apps neste navegador? ' +
    'O launcher e o vault são limpos, outras abas recarregam e os arquivos instalados são restaurados pelo watcher. ' +
    'Somente em desenvolvimento.',
  failed: 'Não foi possível limpar o vault. Verifique se ele está acessível e tente novamente.'
}
const translate = getT(Object.fromEntries(Object.entries(en).map(([key, text]) => [text,
  Object.fromEntries(SUPPORTED_LOCALES.map(locale => [locale, locale === 'pt-BR' ? pt[key] : text]))
])))
// Resolve translations at render/click time, following the launcher locale.
const t = (key, values) => translate(en[key], values)

// Wipes the whole development environment, including the vault accounts that
// make a deleted user come back. Only offered for local development apps,
// where the watcher can reinstall the app files afterwards.
f('local-dev-full-reset-button', ({ h, props }) => {
  const { requestConfirmation } = useConfirmationDialogStore()
  const { showInfo } = useInfoDialogStore()
  const { askVault } = useVaultActor()
  const { isVaultMessengerReady$, vaultIframeRef$ } = useVaultMessengerStore()
  const state = useGlobalStore('local-dev-full-reset', () => ({ status$: {} }))
  const app = props.app$()
  if (!app || !isLocalDevApp(app.id)) return
  const status = state.status$()
  const update = value => state.status$({ ...state.status$(), ...value })
  const reset = async () => {
    if (state.status$()?.busy) return
    update({ busy: true })
    try {
      await requestConfirmation({
        title: t('reset'), confirmText: t('confirm'), message: t('message')
      })
      // A vault iframe that never connected (or was removed) leaves the actor
      // port dangling, so asking would only fail after the whole ask timeout.
      // Fail fast instead so the developer can bring the vault back and retry.
      if (!isVaultMessengerReady$() || !vaultIframeRef$()?.isConnected) {
        throw new Error('Vault is not connected')
      }
      // The vault wipe is a launcher/vault development command, not a signer
      // request, so it must skip the actor queue that refuses everything while
      // nobody is logged in: an environment stuck on the stub user is exactly
      // the one this reset has to be able to clear.
      await requestLocalDevFullReset({
        askVault: (message, options) => askVault(message, { ...options, instant: true })
      })
      // The reset reloads the page; keep the button busy until it does.
    } catch (error) {
      if (error?.code === 'DENIED_BY_USER') {
        update({ busy: false })
        return
      }
      console.error('[local-dev full reset]', error)
      update({ busy: false })
      showInfo({ title: t('errorTitle'), message: t('failed') })
    }
  }
  return h`<div class='local-dev-full-reset'>
    <button type='button' disabled=${!!status?.busy} onclick=${reset}>
      <span class='reset-icon' aria-hidden='true'><icon-database props=${{ size: '16px' }} /></span>
      <span class='reset-label'>${t('reset')}</span>
    </button>
    <style>${`local-dev-full-reset-button .local-dev-full-reset {
      button { display: flex; align-items: center; width: 100%; border: 0; background: transparent; color: inherit; padding: 0; text-align: start; cursor: pointer; }
      .reset-icon { display: flex; flex: 0 0 16px; margin: 10px; }
      .reset-label { flex: 1; min-height: 30px; padding: 10px 10px 10px 3px; }
      button:active { background: ${cssVars.colors.bg2}; }
      button:focus-visible { outline: 2px solid ${cssVars.colors.bgAccentPrimary}; }
    }`}</style>
  </div>`
})
