import { f, useGlobalStore, useWebStorage } from '#f'
import { useConfirmationDialogStore } from '#zones/confirmation-dialog/index.js'
import { getT, SUPPORTED_LOCALES } from '#i18n/index.js'
import { cssVars } from '#assets/styles/theme.js'
import { isLocalDevApp } from './state.js'
import { clearLocalAppData } from './instances.js'

const en = {
  clear: 'Clear local app data and reload',
  confirm: 'Clear data',
  message: 'Clear stored data for {app}, user {user}? Other users and installed files will be kept.',
  failed: 'Some data could not be cleared. Close other instances and try again.'
}
const pt = {
  clear: 'Limpar dados do app local e recarregar',
  confirm: 'Limpar dados',
  message: 'Limpar os dados de {app}, usuário {user}? Outros usuários e arquivos instalados serão mantidos.',
  failed: 'Alguns dados não foram apagados. Feche outras instâncias e tente novamente.'
}
const translate = getT(Object.fromEntries(Object.entries(en).map(([key, text]) => [text,
  Object.fromEntries(SUPPORTED_LOCALES.map(locale => [locale, locale === 'pt-BR' ? pt[key] : text]))
])))
// Resolve translations at render/click time, following the launcher locale.
const t = (key, values) => translate(en[key], values)

// Only the selected development instance can request this user-scoped reset.
f('local-dev-reset-button', ({ h, props }) => {
  const storage = useWebStorage(localStorage)
  const { requestConfirmation } = useConfirmationDialogStore()
  const state = useGlobalStore('local-dev-reset', () => ({ statuses$: {} }))
  const app = props.app$()
  if (!app || !isLocalDevApp(app.id)) return
  const userPk = storage[`session_workspaceByKey_${app.workspaceKey}_userPk$`]()
  const appSubdomain = storage[`session_subdomainByUserAndApp_${userPk}_${app.id}$`]()
  if (!userPk || appSubdomain == null) return
  const key = `${app.id}:${userPk}`
  const status = state.statuses$()[key] || {}
  const update = value => state.statuses$(previous => ({ ...previous, [key]: value }))
  const clear = async () => {
    if (state.statuses$()[key]?.busy) return
    update({ busy: true, error: '' })
    try {
      await requestConfirmation({
        title: t('clear'), confirmText: t('confirm'),
        message: t('message', { app: storage[`session_appById_${app.id}_name$`]() || app.id, user: userPk })
      })
      await clearLocalAppData({ appId: app.id, userPk, appSubdomain })
    } catch (error) {
      if (error.code !== 'DENIED_BY_USER') {
        console.error('[local app reset]', error)
        update({ busy: false, error: t('failed') })
      }
    } finally { update({ ...state.statuses$()[key], busy: false }) }
  }
  return h`<div class='local-dev-reset'>
    <button type='button' disabled=${!!status.busy} onclick=${clear}>${t('clear')}</button>
    ${status.error ? h`<p role='alert'>${status.error}</p>` : ''}
    <style>${`local-dev-reset-button .local-dev-reset {
      button { border: 0; background: transparent; color: inherit; padding: 12px; text-align: start; cursor: pointer; }
      button:active { background: ${cssVars.colors.bg2}; }
      button:focus-visible { outline: 2px solid ${cssVars.colors.bgAccentPrimary}; }
      p { padding: 0 12px; max-width: 280px; }
    }`}</style>
  </div>`
})
