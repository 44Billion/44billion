import { f, useComputed, useStore, useTask, useWebStorage } from '#f'
import { cssVars, jsVars } from '#assets/styles/theme.js'
import { getEffectiveLocale, getT } from '#i18n/index.js'
import { compareAppIdsByName } from '#helpers/app-name-order.js'
import {
  deleteAllPermissionsForApp,
  deletePermission,
  listAllPermissions
} from '#services/idb/browser/queries/permission.js'
import {
  groupPermissionsByApp,
  groupStoredPermissions,
  permissionRecordId
} from '#services/app-permissions.js'
import { permissionDialogLocales } from '#zones/permission-dialog/index.js'
import { useConfirmationDialogStore } from '#zones/confirmation-dialog/index.js'
import '#shared/back-btn.js'
import '#shared/app-icon.js'
import '#shared/pending-indicator.js'
import '#shared/icons/icon-chevron-left.js'
import '#shared/icons/icon-shield-lock.js'

const permissionT = getT(permissionDialogLocales)

export const appDataAccessLocales = getLocales()
const t = getT(appDataAccessLocales)

const SECTION_TEXT = {
  eventData: 'Event data',
  personalCopies: 'Personal copies',
  encryption: 'Encryption',
  other: 'Other permissions'
}

function appNameKey (appId) {
  return `session_appById_${appId}_name`
}

function shortAppId (appId) {
  return appId.length > 34 ? `${appId.slice(0, 18)}...${appId.slice(-12)}` : appId
}

f('app-data-access', function () {
  const storage = useWebStorage(localStorage)
  const { requestConfirmation } = useConfirmationDialogStore()

  const cachedAppName = appId => {
    const value = storage[`${appNameKey(appId)}$`]()
    return typeof value === 'string' ? value.trim() : ''
  }

  const state = useStore(() => ({
    groups$: [],
    loading$: true,
    loadError$: false,
    expandedAppId$: null,
    revoking$: {},
    actionErrors$: {},

    async load () {
      this.loading$(true)
      this.loadError$(false)
      try {
        this.groups$(groupPermissionsByApp(await listAllPermissions()))
      } catch (error) {
        console.error('Could not load app permissions', error)
        this.loadError$(true)
      } finally {
        this.loading$(false)
      }
    },

    toggleApp (appId) {
      this.expandedAppId$(current => current === appId ? null : appId)
    },

    clearActionError (appId) {
      this.actionErrors$(previous => {
        if (!previous[appId]) return previous
        const next = { ...previous }
        delete next[appId]
        return next
      })
    },

    setActionError (appId, message) {
      this.actionErrors$(previous => ({ ...previous, [appId]: message }))
    },

    async revoke (permission) {
      const id = permissionRecordId(permission)
      if (this.revoking$()[id]) return
      this.revoking$(previous => ({ ...previous, [id]: true }))
      this.clearActionError(permission.appId)
      try {
        await deletePermission(permission.appId, permission.name, permission.eKind, permission.scope)
        this.groups$(previous => previous
          .map(group => group.appId === permission.appId
            ? {
                ...group,
                permissions: group.permissions.filter(item => permissionRecordId(item) !== id)
              }
            : group)
          .filter(group => group.permissions.length > 0))
      } catch (error) {
        console.error('Could not revoke app permission', error)
        this.setActionError(permission.appId, t('Could not revoke permission. Try again.'))
      } finally {
        this.revoking$(previous => {
          if (!previous[id]) return previous
          const next = { ...previous }
          delete next[id]
          return next
        })
      }
    },

    async revokeAll (appId) {
      const busyKey = `app:${appId}`
      if (this.revoking$()[busyKey]) return
      const appLabel = cachedAppName(appId) || t('Unknown app')
      try {
        await requestConfirmation({
          title: t('Revoke all permissions?'),
          message: t('Revoke all permissions for {{app}}? Open app windows will remain open. Future protected requests will ask again.', { app: appLabel }),
          confirmText: t('Revoke all'),
          maxWidth: '560px'
        })
      } catch {
        return
      }

      this.revoking$(previous => ({ ...previous, [busyKey]: true }))
      this.clearActionError(appId)
      try {
        await deleteAllPermissionsForApp(appId)
        this.groups$(previous => previous.filter(group => group.appId !== appId))
        if (this.expandedAppId$() === appId) this.expandedAppId$(null)
      } catch (error) {
        console.error('Could not revoke all app permissions', error)
        this.setActionError(appId, t('Could not revoke permission. Try again.'))
      } finally {
        this.revoking$(previous => {
          if (!previous[busyKey]) return previous
          const next = { ...previous }
          delete next[busyKey]
          return next
        })
      }
    }
  }))

  useTask(() => {
    state.load()
  })

  const apps$ = useComputed(() => {
    const collator = new Intl.Collator(getEffectiveLocale(), {
      numeric: true,
      sensitivity: 'base'
    })
    return state.groups$().slice().sort((left, right) =>
      compareAppIdsByName(left.appId, right.appId, {
        getAppName: cachedAppName,
        collator
      })
    )
  })

  const permissionCount$ = useComputed(() =>
    state.groups$().reduce((total, group) => total + group.permissions.length, 0)
  )

  return this.h`
    <style>${/* css */`
      app-data-access {
        flex-grow: 1;
        width: 100%;
        min-width: 0;
        min-height: 0;
        display: flex !important;
        flex-direction: column;
        height: 100%;
        background-color: ${cssVars.colors.bg};
        color: ${cssVars.colors.fg};

        .header {
          width: 100%;
          max-width: 900px;
          margin-inline: auto;
          height: 55px;
          display: flex;
          align-items: center;
          padding: 0 10px;
          flex-shrink: 0;
        }
        .title {
          flex-grow: 1;
          margin-left: 10px;
          font-size: 18rem;
          font-weight: 500;
        }
        .scroll-area {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
        }
        .content {
          width: 100%;
          max-width: 900px;
          margin-inline: auto;
          padding: 20px;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .summary {
          display: flex;
          flex-wrap: wrap;
          gap: 8px 16px;
          color: ${cssVars.colors.fg2};
          font-size: 13rem;
        }
        .count {
          color: ${cssVars.colors.fg};
          font-weight: 600;
        }
        .app-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .state-card {
          min-height: 180px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          padding: 24px;
          border-radius: 14px;
          background-color: ${cssVars.colors.bg2};
          color: ${cssVars.colors.fg2};
          text-align: center;
        }
        .state-card icon-shield-lock {
          color: ${cssVars.colors.bgAccentSecondary};
        }
        .retry-button {
          padding: 8px 14px;
          border: 0;
          border-radius: 6px;
          background-color: ${cssVars.colors.bgAccentPrimary};
          color: ${cssVars.colors.fgAccent};
          cursor: pointer;
          font: inherit;
          font-weight: 600;
        }
        .notes {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 14px 16px;
          border-radius: 10px;
          background-color: ${cssVars.colors.bg2};
          color: ${cssVars.colors.fg2};
          font-size: 13rem;
          line-height: 1.4;
        }
        @media ${jsVars.breakpoints.mobile} {
          .content {
            padding: 12px 10px 20px;
          }
        }
      }

      app-data-access-card {
        .app-card {
          overflow: hidden;
          border-radius: 14px;
          background-color: ${cssVars.colors.bg2};
        }
        .app-toggle {
          width: 100%;
          min-height: 68px;
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 12px 14px;
          border: 0;
          background: transparent;
          color: ${cssVars.colors.fg};
          cursor: pointer;
          font: inherit;
          text-align: left;
        }
        .app-toggle:focus-visible,
        .revoke-button:focus-visible,
        .revoke-all:focus-visible,
        .retry-button:focus-visible {
          outline: 2px solid ${cssVars.colors.bgAccentPrimary};
          outline-offset: 2px;
        }
        .app-icon {
          width: 46px;
          height: 46px;
          flex-shrink: 0;
          overflow: hidden;
          border-radius: 11px;
          background-color: ${cssVars.colors.bgAvatar};
        }
        .app-copy {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .app-name {
          overflow: hidden;
          color: ${cssVars.colors.fg};
          font-size: 16rem;
          font-weight: 600;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .app-id,
        .permission-meta {
          color: ${cssVars.colors.fg2};
          font-size: 12rem;
        }
        .app-count {
          min-width: 22px;
          padding: 3px 7px;
          border-radius: 999px;
          background-color: ${cssVars.colors.bg3};
          color: ${cssVars.colors.fg};
          font-size: 12rem;
          font-weight: 600;
          text-align: center;
        }
        .chevron {
          flex-shrink: 0;
          color: ${cssVars.colors.fg2};
        }
        .permission-panel {
          padding: 0 0 14px;
        }
        .permission-group {
          border-top: 1px solid ${cssVars.colors.bg3};
        }
        .permission-group + .permission-group {
          border-top: 0;
        }
        .permission-group-content {
          padding: 12px 14px 0;
        }
        .permission-actions {
          padding: 10px 14px 0;
        }
        .permission-group-title {
          margin-bottom: 4px;
          color: ${cssVars.colors.fg2};
          font-size: 12rem;
          font-weight: 600;
          text-transform: uppercase;
        }
        .permission-row {
          display: flex;
          align-items: center;
          gap: 12px;
          min-height: 54px;
          padding: 6px 0;
        }
        .permission-copy {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .permission-title {
          color: ${cssVars.colors.fg};
          font-size: 14rem;
          font-weight: 500;
        }
        .permission-title::first-letter {
          text-transform: uppercase;
        }
        .broad-badge {
          flex-shrink: 0;
          padding: 3px 7px;
          border-radius: 999px;
          color: ${cssVars.colors.bgAccentSecondary};
          font-size: 11rem;
          font-weight: 600;
        }
        .revoke-button,
        .revoke-all {
          padding: 8px 16px;
          border-radius: 6px;
          border: none;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14rem;
          cursor: pointer;
          background-color: ${cssVars.colors.overlayHover};
          white-space: nowrap;
        }
        .revoke-button:hover {
          background-color: ${cssVars.colors.overlaySelected};
        }
        .revoke-button:disabled,
        .revoke-all:disabled {
          opacity: 0.55;
          cursor: default;
        }
        .revoke-all {
          font-weight: 600;
          background-color: ${cssVars.colors.bgAccentPrimary};
          color: ${cssVars.colors.fgAccent};
          transition: filter 0.2s;
        }
        .revoke-all:hover {
          filter: brightness(1.1);
          background-color: ${cssVars.colors.bgAccentPrimary};
        }
        .action-error {
          margin-top: 8px;
          color: ${cssVars.colors.fgError};
          font-size: 13rem;
        }
        @media ${jsVars.breakpoints.mobile} {
          .app-toggle {
            gap: 10px;
            padding-inline: 12px;
          }
          .permission-group-content,
          .permission-actions {
            padding-inline: 12px;
          }
          .permission-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            grid-template-areas:
              "copy action"
              "badge action";
            align-items: flex-start;
            gap: 6px 12px;
          }
          .permission-copy {
            grid-area: copy;
          }
          .broad-badge {
            grid-area: badge;
            justify-self: start;
          }
          .revoke-button {
            grid-area: action;
            align-self: start;
          }
        }
      }
    `}</style>

    <div class="header">
      <back-btn />
      <div class="title">${t('App Data Access')}</div>
    </div>

    <div class="scroll-area">
      <div class="content">
        ${!state.loading$() && !state.loadError$() && apps$().length > 0
          ? this.h`
            <div class="summary">
              <span>${t('Apps with access')} <span class="count">${apps$().length}</span></span>
              <span>${t('Permissions')} <span class="count">${permissionCount$()}</span></span>
            </div>
          `
          : ''}

        ${state.loading$()
          ? this.h`<pending-indicator props=${{ text: t('Loading...') }} />`
          : state.loadError$()
            ? this.h`
              <div class="state-card" role="alert">
                <span>${t('Could not load app permissions.')}</span>
                <button class="retry-button" onclick=${state.load}>${t('Try again')}</button>
              </div>
            `
            : apps$().length === 0
              ? this.h`
                <div class="state-card">
                  <icon-shield-lock props=${{ size: '34px' }} />
                  <span>${t('No apps have access to your data.')}</span>
                </div>
              `
              : this.h`
                <div class="app-list">
                  <div style="display: contents"></div>
                  ${apps$().map(group => this.h({ key: group.appId })`
                    <app-data-access-card props=${{
                      appId: group.appId,
                      permissions$: () => state.groups$()
                        .find(item => item.appId === group.appId)?.permissions ?? [],
                      expanded$: () => state.expandedAppId$() === group.appId,
                      revoking$: () => state.revoking$(),
                      error$: () => state.actionErrors$()[group.appId] ?? '',
                      onToggle: () => state.toggleApp(group.appId),
                      onRevoke: permission => state.revoke(permission),
                      onRevokeAll: () => state.revokeAll(group.appId)
                    }} />
                  `)}
                </div>
              `}

        <div class="notes">
          <span>${t('Changes apply to future protected requests. No app windows will be reloaded.')}</span>
          <span>${t('Revoking access does not delete data already stored by the app.')}</span>
        </div>
      </div>
    </div>
  `
})

f('app-data-access-card', function () {
  const storage = useWebStorage(localStorage)
  const { appId, permissions$, expanded$, revoking$, error$, onToggle, onRevoke, onRevokeAll } = this.props
  const name$ = useComputed(() => {
    const value = storage[`${appNameKey(appId)}$`]()
    return typeof value === 'string' ? value.trim() : ''
  })
  const permissions = permissions$()
  const expanded = expanded$()
  const revoking = revoking$()
  const error = error$()
  const groups = groupStoredPermissions(permissions, {
    translate: t,
    translateKind: permissionT
  })
  const renderedGroups = groups.map(group => ({
    ...group,
    rows: group.rows.map(row => ({
      ...row,
      meta: [
        row.kind >= 0 ? t('Kind {{kind}}', { kind: row.kind }) : '',
        row.scopeLabel ? permissionT('Scope: {{scope}}', { scope: row.scopeLabel }) : ''
      ].filter(Boolean).join(' · ')
    }))
  }))
  const appBusy = Boolean(revoking[`app:${appId}`])
  const appActionBusy = appBusy || permissions.some(permission => Boolean(revoking[permissionRecordId(permission)]))
  const displayName = name$() || t('Unknown app')

  return this.h`
    <div class="app-card">
      <button
        type="button"
        class="app-toggle"
        aria-expanded=${String(expanded)}
        onclick=${onToggle}
      >
        <div class="app-icon">
          <app-icon props=${{
            app$: () => ({ id: appId, name: name$() })
          }} />
        </div>
        <div class="app-copy">
          <span class="app-name">${displayName}</span>
          ${name$() ? '' : this.h`<span class="app-id">${t('App ID: {{id}}', { id: shortAppId(appId) })}</span>`}
        </div>
        <span class="app-count">${permissions.length}</span>
        <icon-chevron-left class="chevron" props=${{ size: '18px', rotate: expanded ? 90 : 270 }} />
      </button>

      ${expanded
        ? this.h`
          <div class="permission-panel">
            ${renderedGroups.map(group => this.h({ key: `${appId}:${group.id}` })`
              <div class="permission-group">
                <div class="permission-group-content">
                  <div class="permission-group-title">${t(SECTION_TEXT[group.id])}</div>
                  ${group.rows.map(row => this.h({ key: row.id })`
                    <div class="permission-row">
                      <div class="permission-copy">
                        <span class="permission-title">${row.title}</span>
                        ${row.meta ? this.h`<span class="permission-meta">${row.meta}</span>` : ''}
                      </div>
                      ${row.broad ? this.h`<span class="broad-badge">${t('Broad access')}</span>` : ''}
                      <button
                        type="button"
                        class="revoke-button"
                        aria-label=${`${t('Revoke')}: ${row.title}`}
                        disabled=${appActionBusy}
                        onclick=${() => onRevoke(row.permission)}
                      >${revoking[row.id] ? t('Revoking...') : t('Revoke')}</button>
                    </div>
                  `)}
                </div>
              </div>
            `)}
            <div class="permission-actions">
              <button
                type="button"
                class="revoke-all"
                disabled=${appActionBusy}
                onclick=${onRevokeAll}
              >${appBusy ? t('Revoking...') : t('Revoke all')}</button>
              ${error ? this.h`<div class="action-error" role="alert">${error}</div>` : ''}
            </div>
          </div>
        `
        : ''}
    </div>
  `
})

function l (en, fr, it, de, es, ptBR, ru, zhCN, zhTW, ja, ko) {
  return { en, fr, it, de, es, 'pt-BR': ptBR, ru, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko }
}

function getLocales () {
  return {
    'App Data Access': l('App Data Access', 'Accès aux données des applications', 'Accesso ai dati delle app', 'App-Datenzugriff', 'Acceso a datos de apps', 'Acesso a dados dos apps', 'Доступ приложений к данным', '应用数据访问', '應用程式資料存取', 'アプリデータアクセス', '앱 데이터 접근'),
    'Apps with access': l('Apps with access', 'Applications ayant accès', 'App con accesso', 'Apps mit Zugriff', 'Aplicaciones con acceso', 'Apps com acesso', 'Приложения с доступом', '有访问权限的应用', '有存取權限的應用程式', 'アクセス権があるアプリ', '접근 권한이 있는 앱'),
    Permissions: l('Permissions', 'Autorisations', 'Autorizzazioni', 'Berechtigungen', 'Permisos', 'Permissões', 'Разрешения', '权限', '權限', '権限', '권한'),
    'No apps have access to your data.': l('No apps have access to your data.', 'Aucune application n’a accès à vos données.', 'Nessuna app ha accesso ai tuoi dati.', 'Keine App hat Zugriff auf Ihre Daten.', 'Ninguna aplicación tiene acceso a tus datos.', 'Nenhum app tem acesso aos seus dados.', 'Ни одно приложение не имеет доступа к вашим данным.', '没有应用可以访问您的数据。', '沒有應用程式可以存取您的資料。', 'データにアクセスできるアプリはありません。', '데이터에 접근할 수 있는 앱이 없습니다.'),
    'Event data': l('Event data', 'Données d’événements', 'Dati degli eventi', 'Ereignisdaten', 'Datos de eventos', 'Dados de eventos', 'Данные событий', '事件数据', '事件資料', 'イベントデータ', '이벤트 데이터'),
    'Personal copies': l('Personal copies', 'Copies personnelles', 'Copie personali', 'Persönliche Kopien', 'Copias personales', 'Cópias pessoais', 'Личные копии', '个人副本', '個人副本', '個人用コピー', '개인 사본'),
    Encryption: l('Encryption', 'Chiffrement', 'Crittografia', 'Verschlüsselung', 'Cifrado', 'Criptografia', 'Шифрование', '加密', '加密', '暗号化', '암호화'),
    'Other permissions': l('Other permissions', 'Autres autorisations', 'Altre autorizzazioni', 'Weitere Berechtigungen', 'Otros permisos', 'Outras permissões', 'Другие разрешения', '其他权限', '其他權限', 'その他の権限', '기타 권한'),
    'All app data': l('All app data', 'Toutes les données des applications', 'Tutti i dati delle app', 'Alle App-Daten', 'Todos los datos de las aplicaciones', 'Todos os dados dos apps', 'Все данные приложений', '所有应用数据', '所有應用程式資料', 'すべてのアプリデータ', '모든 앱 데이터'),
    'All personal data': l('All personal data', 'Toutes les données personnelles', 'Tutti i dati personali', 'Alle persönlichen Daten', 'Todos los datos personales', 'Todos os dados pessoais', 'Все личные данные', '所有个人数据', '所有個人資料', 'すべての個人データ', '모든 개인 데이터'),
    'Encrypt or decrypt any data': l('Encrypt or decrypt any data', 'Chiffrer ou déchiffrer toutes les données', 'Cifra o decifra qualsiasi dato', 'Alle Daten verschlüsseln oder entschlüsseln', 'Cifrar o descifrar cualquier dato', 'Criptografar ou descriptografar qualquer dado', 'Шифровать или расшифровывать любые данные', '加密或解密任何数据', '加密或解密任何資料', '任意のデータを暗号化または復号', '모든 데이터 암호화 또는 복호화'),
    'Broad access': l('Broad access', 'Accès étendu', 'Accesso ampio', 'Breiter Zugriff', 'Acceso amplio', 'Acesso amplo', 'Широкий доступ', '广泛访问', '廣泛存取', '広範なアクセス', '광범위한 접근'),
    'Kind {{kind}}': l('Kind {{kind}}', 'Type {{kind}}', 'Tipo {{kind}}', 'Typ {{kind}}', 'Tipo {{kind}}', 'Tipo {{kind}}', 'Тип {{kind}}', '类型 {{kind}}', '類型 {{kind}}', '種類 {{kind}}', '종류 {{kind}}'),
    Revoke: l('Revoke', 'Révoquer', 'Revoca', 'Widerrufen', 'Revocar', 'Revogar', 'Отозвать', '撤销', '撤銷', '取り消す', '철회'),
    'Revoking...': l('Revoking...', 'Révocation...', 'Revoca in corso...', 'Wird widerrufen...', 'Revocando...', 'Revogando...', 'Отзыв...', '正在撤销...', '正在撤銷...', '取り消し中...', '철회 중...'),
    'Revoke all': l('Revoke all', 'Tout révoquer', 'Revoca tutto', 'Alle widerrufen', 'Revocar todo', 'Revogar tudo', 'Отозвать все', '全部撤销', '全部撤銷', 'すべて取り消す', '모두 철회'),
    'Revoke all permissions?': l('Revoke all permissions?', 'Révoquer toutes les autorisations ?', 'Revocare tutte le autorizzazioni?', 'Alle Berechtigungen widerrufen?', '¿Revocar todos los permisos?', 'Revogar todas as permissões?', 'Отозвать все разрешения?', '撤销所有权限？', '撤銷所有權限？', 'すべての権限を取り消しますか？', '모든 권한을 철회할까요?'),
    'Revoke all permissions for {{app}}? Open app windows will remain open. Future protected requests will ask again.': l('Revoke all permissions for {{app}}? Open app windows will remain open. Future protected requests will ask again.', 'Révoquer toutes les autorisations pour {{app}} ? Les fenêtres ouvertes resteront ouvertes. Les futures requêtes protégées demanderont à nouveau l’autorisation.', 'Revocare tutte le autorizzazioni per {{app}}? Le finestre aperte resteranno aperte. Le future richieste protette chiederanno di nuovo il permesso.', 'Alle Berechtigungen für {{app}} widerrufen? Geöffnete App-Fenster bleiben geöffnet. Künftige geschützte Anfragen fragen erneut.', '¿Revocar todos los permisos de {{app}}? Las ventanas abiertas seguirán abiertas. Las futuras solicitudes protegidas volverán a pedir permiso.', 'Revogar todas as permissões de {{app}}? As janelas abertas continuarão abertas. Futuras solicitações protegidas pedirão novamente.', 'Отозвать все разрешения для {{app}}? Открытые окна приложения останутся открытыми. Будущие защищённые запросы снова запросят разрешение.', '撤销 {{app}} 的所有权限？已打开的应用窗口将保持打开。以后受到保护的请求会再次询问。', '撤銷 {{app}} 的所有權限？已開啟的應用程式視窗將保持開啟。之後受保護的要求會再次詢問。', '{{app}} のすべての権限を取り消しますか？開いているアプリウィンドウは開いたままです。今後保護されたリクエストでは再び確認されます。', '{{app}}의 모든 권한을 철회할까요? 열린 앱 창은 계속 열려 있습니다. 향후 보호된 요청은 다시 권한을 묻습니다.'),
    'Could not revoke permission. Try again.': l('Could not revoke permission. Try again.', 'Impossible de révoquer l’autorisation. Réessayez.', 'Impossibile revocare l’autorizzazione. Riprova.', 'Berechtigung konnte nicht widerrufen werden. Versuchen Sie es erneut.', 'No se pudo revocar el permiso. Inténtalo de nuevo.', 'Não foi possível revogar a permissão. Tente novamente.', 'Не удалось отозвать разрешение. Повторите попытку.', '无法撤销权限，请重试。', '無法撤銷權限，請再試一次。', '権限を取り消せませんでした。もう一度お試しください。', '권한을 철회하지 못했습니다. 다시 시도하세요.'),
    'Could not load app permissions.': l('Could not load app permissions.', 'Impossible de charger les autorisations des applications.', 'Impossibile caricare le autorizzazioni delle app.', 'App-Berechtigungen konnten nicht geladen werden.', 'No se pudieron cargar los permisos de las aplicaciones.', 'Não foi possível carregar as permissões dos apps.', 'Не удалось загрузить разрешения приложений.', '无法加载应用权限。', '無法載入應用程式權限。', 'アプリの権限を読み込めませんでした。', '앱 권한을 불러오지 못했습니다.'),
    'Loading...': l('Loading...', 'Chargement...', 'Caricamento...', 'Wird geladen...', 'Cargando...', 'Carregando...', 'Загрузка...', '正在加载...', '正在載入...', '読み込み中...', '불러오는 중...'),
    'Try again': l('Try again', 'Réessayer', 'Riprova', 'Erneut versuchen', 'Intentar de nuevo', 'Tentar novamente', 'Повторить', '重试', '再試一次', '再試行', '다시 시도'),
    'Unknown app': l('Unknown app', 'Application inconnue', 'App sconosciuta', 'Unbekannte App', 'Aplicación desconocida', 'App desconhecido', 'Неизвестное приложение', '未知应用', '未知應用程式', '不明なアプリ', '알 수 없는 앱'),
    'App ID: {{id}}': l('App ID: {{id}}', 'ID de l’application : {{id}}', 'ID app: {{id}}', 'App-ID: {{id}}', 'ID de la aplicación: {{id}}', 'ID do app: {{id}}', 'ID приложения: {{id}}', '应用 ID：{{id}}', '應用程式 ID：{{id}}', 'アプリ ID：{{id}}', '앱 ID: {{id}}'),
    'Changes apply to future protected requests. No app windows will be reloaded.': l('Changes apply to future protected requests. No app windows will be reloaded.', 'Les modifications s’appliquent aux futures requêtes protégées. Aucune fenêtre d’application ne sera rechargée.', 'Le modifiche si applicano alle future richieste protette. Nessuna finestra dell’app verrà ricaricata.', 'Änderungen gelten für künftige geschützte Anfragen. App-Fenster werden nicht neu geladen.', 'Los cambios se aplican a futuras solicitudes protegidas. No se recargará ninguna ventana de aplicación.', 'As alterações valem para futuras solicitações protegidas. Nenhuma janela de app será recarregada.', 'Изменения применяются к будущим защищённым запросам. Окна приложений не будут перезагружены.', '更改适用于以后受到保护的请求。应用窗口不会重新加载。', '變更適用於之後受保護的要求。應用程式視窗不會重新載入。', '変更は今後の保護されたリクエストに適用されます。アプリウィンドウは再読み込みされません。', '변경 사항은 향후 보호된 요청에 적용됩니다. 앱 창은 다시 로드되지 않습니다.'),
    'Revoking access does not delete data already stored by the app.': l('Revoking access does not delete data already stored by the app.', 'La révocation de l’accès ne supprime pas les données déjà stockées par l’application.', 'La revoca dell’accesso non elimina i dati già archiviati dall’app.', 'Das Widerrufen des Zugriffs löscht keine Daten, die die App bereits gespeichert hat.', 'Revocar el acceso no elimina los datos que la aplicación ya haya guardado.', 'Revogar o acesso não exclui dados que o app já tenha armazenado.', 'Отзыв доступа не удаляет данные, уже сохранённые приложением.', '撤销访问权限不会删除应用已经存储的数据。', '撤銷存取權限不會刪除應用程式已儲存的資料。', 'アクセスを取り消しても、アプリがすでに保存したデータは削除されません。', '접근 권한을 철회해도 앱이 이미 저장한 데이터는 삭제되지 않습니다.')
  }
}
