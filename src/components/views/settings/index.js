import { f, useSignal, useCallback, useComputed } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import useLocation from '#hooks/use-location.js'
import { cssVars } from '#assets/styles/theme.js'
import '#shared/back-btn.js'
import '#shared/toggle-switch.js'
import '#shared/icons/icon-check.js'
import '#shared/icons/icon-cancel.js'
import '#shared/icons/icon-chevron-left.js'
import {
  AUTO_LOCALE,
  getLocalePreference,
  getT,
  setLocalePreference,
  SUPPORTED_LOCALES
} from '#i18n/index.js'
import useLocale from '#i18n/use-locale.js'

export const settingsLocales = {
  Settings: { en: 'Settings', fr: 'Paramètres', it: 'Impostazioni', de: 'Einstellungen', es: 'Configuración', 'pt-BR': 'Configurações', ru: 'Настройки', 'zh-CN': '设置', 'zh-TW': '設定', ja: '設定', ko: '설정' },
  General: { en: 'General', fr: 'Général', it: 'Generali', de: 'Allgemein', es: 'General', 'pt-BR': 'Geral', ru: 'Общие', 'zh-CN': '常规', 'zh-TW': '一般', ja: '一般', ko: '일반' },
  Language: { en: 'Language', fr: 'Langue', it: 'Lingua', de: 'Sprache', es: 'Idioma', 'pt-BR': 'Idioma', ru: 'Язык', 'zh-CN': '语言', 'zh-TW': '語言', ja: '言語', ko: '언어' },
  'Choose the interface language': { en: 'Choose the interface language', fr: 'Choisir la langue de l’interface', it: 'Scegli la lingua dell’interfaccia', de: 'Sprache der Benutzeroberfläche auswählen', es: 'Elegir el idioma de la interfaz', 'pt-BR': 'Escolher o idioma da interface', ru: 'Выбрать язык интерфейса', 'zh-CN': '选择界面语言', 'zh-TW': '選擇介面語言', ja: 'インターフェースの言語を選択', ko: '인터페이스 언어 선택' },
  Automatic: { en: 'Automatic', fr: 'Automatique', it: 'Automatico', de: 'Automatisch', es: 'Automático', 'pt-BR': 'Automático', ru: 'Автоматически', 'zh-CN': '自动', 'zh-TW': '自動', ja: '自動', ko: '자동' },
  'Auto Update': { en: 'Auto Update', fr: 'Mise à jour automatique', it: 'Aggiornamento automatico', de: 'Automatische Updates', es: 'Actualización automática', 'pt-BR': 'Atualização automática', ru: 'Автообновление', 'zh-CN': '自动更新', 'zh-TW': '自動更新', ja: '自動更新', ko: '자동 업데이트' },
  'When to install app updates': { en: 'When to install app updates', fr: 'Quand installer les mises à jour', it: 'Quando installare gli aggiornamenti', de: 'Wann App-Updates installiert werden', es: 'Cuándo instalar actualizaciones', 'pt-BR': 'Quando instalar atualizações de apps', ru: 'Когда устанавливать обновления', 'zh-CN': '何时安装应用更新', 'zh-TW': '何時安裝應用程式更新', ja: 'アプリの更新をインストールするタイミング', ko: '앱 업데이트 설치 시기' },
  Always: { en: 'Always', fr: 'Toujours', it: 'Sempre', de: 'Immer', es: 'Siempre', 'pt-BR': 'Sempre', ru: 'Всегда', 'zh-CN': '始终', 'zh-TW': '一律', ja: '常に', ko: '항상' },
  'Wi-Fi only': { en: 'Wi-Fi only', fr: 'Wi-Fi uniquement', it: 'Solo Wi-Fi', de: 'Nur WLAN', es: 'Solo Wi-Fi', 'pt-BR': 'Somente Wi-Fi', ru: 'Только Wi-Fi', 'zh-CN': '仅 Wi-Fi', 'zh-TW': '僅限 Wi-Fi', ja: 'Wi-Fi のみ', ko: 'Wi-Fi만' },
  Manual: { en: 'Manual', fr: 'Manuel', it: 'Manuale', de: 'Manuell', es: 'Manual', 'pt-BR': 'Manual', ru: 'Вручную', 'zh-CN': '手动', 'zh-TW': '手動', ja: '手動', ko: '수동' },
  'App Updates': { en: 'App Updates', fr: 'Mises à jour des applications', it: 'Aggiornamenti delle app', de: 'App-Updates', es: 'Actualizaciones de aplicaciones', 'pt-BR': 'Atualizações de apps', ru: 'Обновления приложений', 'zh-CN': '应用更新', 'zh-TW': '應用程式更新', ja: 'アプリの更新', ko: '앱 업데이트' },
  'Check for updates': { en: 'Check for updates', fr: 'Rechercher des mises à jour', it: 'Controlla aggiornamenti', de: 'Nach Updates suchen', es: 'Buscar actualizaciones', 'pt-BR': 'Procurar atualizações', ru: 'Проверить обновления', 'zh-CN': '检查更新', 'zh-TW': '檢查更新', ja: '更新を確認', ko: '업데이트 확인' },
  'Multi-Window Mode': { en: 'Multi-Window Mode', fr: 'Mode multifenêtre', it: 'Modalità multi-finestra', de: 'Mehrfenstermodus', es: 'Modo multiventana', 'pt-BR': 'Modo de múltiplas janelas', ru: 'Многооконный режим', 'zh-CN': '多窗口模式', 'zh-TW': '多視窗模式', ja: 'マルチウィンドウモード', ko: '다중 창 모드' },
  'Toggle between single and multi-window mode': { en: 'Toggle between single and multi-window mode', fr: 'Basculer entre une ou plusieurs fenêtres', it: 'Passa dalla modalità a finestra singola a quella multipla', de: 'Zwischen Ein- und Mehrfenstermodus wechseln', es: 'Alternar entre una y varias ventanas', 'pt-BR': 'Alternar entre uma ou várias janelas', ru: 'Переключить однооконный или многооконный режим', 'zh-CN': '切换单窗口和多窗口模式', 'zh-TW': '切換單視窗與多視窗模式', ja: '単一ウィンドウとマルチウィンドウを切り替え', ko: '단일 창과 다중 창 모드 전환' },
  Advanced: { en: 'Advanced', fr: 'Avancé', it: 'Avanzate', de: 'Erweitert', es: 'Avanzado', 'pt-BR': 'Avançado', ru: 'Дополнительно', 'zh-CN': '高级', 'zh-TW': '進階', ja: '詳細設定', ko: '고급' },
  'Credential Vault URL': { en: 'Credential Vault URL', fr: 'URL du coffre d’identifiants', it: 'URL del vault delle credenziali', de: 'URL des Anmeldedatentresors', es: 'URL de la bóveda de credenciales', 'pt-BR': 'URL do cofre de credenciais', ru: 'URL хранилища учётных данных', 'zh-CN': '凭据保管库 URL', 'zh-TW': '憑證保管庫 URL', ja: '認証情報保管庫の URL', ko: '자격 증명 보관소 URL' }
}

const t = getT(settingsLocales)

const LOCALE_NAMES = Object.freeze({
  en: 'English',
  fr: 'Français',
  it: 'Italiano',
  de: 'Deutsch',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
  ko: '한국어'
})

f('a-settings', function () {
  useLocale()
  const storage = useWebStorage(localStorage)
  const {
    config_isSingleWindow$: isSingleWindow$,
    config_appUpdateMode$: appUpdateMode$,
    config_vaultUrl$: vaultUrl$,
    session_unread_appUpdateCount$: appUpdateCount$
  } = storage
  const updateMode$ = useComputed(() => appUpdateMode$() ?? 'always')
  const isManualUpdate$ = useComputed(() => updateMode$() === 'manual')
  const showAppUpdatesBadge$ = useComputed(() => isManualUpdate$() && (appUpdateCount$() ?? 0) > 0)
  const location = useLocation()

  const draftVaultUrl$ = useSignal(vaultUrl$())
  const hasVaultUrlError$ = useSignal(false)

  const handleVaultUrlChange = useCallback(e => {
    draftVaultUrl$(e.target.value)
  })

  const saveVaultUrl = useCallback(() => {
    let nextUrl = draftVaultUrl$().trim()
    if (nextUrl.startsWith('//')) {
      nextUrl = `${window.location.protocol}${nextUrl}`
    } else if (!nextUrl.includes('://')) {
      nextUrl = `${window.location.protocol}//${nextUrl}`
    }

    try {
      const url = new URL(nextUrl)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        // Avoid triple slash like on "https:///localhost:4000"
        [url.href, url.href.replace(/\/$/, '')].every(v => v !== nextUrl)
      ) {
        throw new Error('Invalid URL')
      }
      vaultUrl$(nextUrl)
      draftVaultUrl$(nextUrl)
    } catch (_e) {
      hasVaultUrlError$(true)
      setTimeout(() => hasVaultUrlError$(false), 2000)
    }
  })

  const cancelVaultUrlChange = useCallback(() => {
    draftVaultUrl$(vaultUrl$())
  })

  return this.h`
    <style>${`
      a-settings {
        flex-grow: 1;
        max-width: 900px;
        display: flex !important;
        flex-direction: column;
        height: 100%;
        background-color: ${cssVars.colors.bg};
        color: ${cssVars.colors.fg};
      }
      .header {
        height: 55px;
        display: flex;
        align-items: center;
        padding: 0 10px;
        flex-shrink: 0;
        border-bottom: 1px solid ${cssVars.colors.bg2};
      }
      .title {
        flex-grow: 1;
        font-weight: 500;
        font-size: 18rem;
        margin-left: 10px;
      }
      .content {
        padding: 20px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      .section {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .section-title {
        font-size: 14rem;
        color: ${cssVars.colors.fgAccent};
        font-weight: 500;
        text-transform: uppercase;
      }
      .item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 15px;
        background-color: ${cssVars.colors.bg2};
        border-radius: 8px;
        cursor: pointer;
      }
      .app-updates-item {
        overflow: hidden;
        max-height: 200px;
        margin-top: 0;
        transition: max-height 0.3s ease, opacity 0.3s ease, padding 0.3s ease, margin-top 0.3s ease;
      }
      .app-updates-item.collapsed {
        max-height: 0;
        opacity: 0;
        padding-top: 0;
        padding-bottom: 0;
        margin-top: -10px; /* absorbs the .section's row gap so siblings don't get a phantom gap */
        pointer-events: none;
      }
      .item-content {
        display: flex;
        flex-direction: column;
      }
      .item-title {
        font-size: 16rem;
        font-weight: 500;
      }
      .item-subtitle {
        font-size: 14rem;
        color: ${cssVars.colors.fg2};
        margin-top: 4px;
      }
      .badge {
        background-color: ${cssVars.colors.bgAccentPrimary};
        color: ${cssVars.colors.fgAccent};
        padding: 4px 8px 2px;
        border-radius: 12px;
        font-size: 12rem;
        font-weight: bold;
      }
      .input-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      input[type="text"] {
        padding: 10px;
        border-radius: 4px;
        border: 1px solid ${cssVars.colors.bg3};
        background-color: ${cssVars.colors.bg};
        color: ${cssVars.colors.fg};
        font-size: 16rem;
      }
      .update-mode-select-wrapper {
        position: relative;
        display: inline-flex;
        align-items: center;
      }
      .update-mode-select {
        appearance: none;
        padding: 8px 32px 8px 10px;
        border-radius: 4px;
        border: 1px solid ${cssVars.colors.bg3};
        background-color: ${cssVars.colors.bg};
        color: ${cssVars.colors.fg};
        font-size: 14rem;
        cursor: pointer;
      }
      .update-mode-select-chevron svg {
        position: absolute;
        right: 8px;
        pointer-events: none !important;
      }
    `}</style>

    <div class="header">
      <back-btn />
      <div class="title">${t('Settings')}</div>
    </div>

    <div class="content">
      <div class="section">
        <div class="section-title">${t('General')}</div>

        <div class="item">
          <div class="item-content">
            <div class="item-title">${t('Language')}</div>
            <div class="item-subtitle">${t('Choose the interface language')}</div>
          </div>
          <div class="update-mode-select-wrapper">
            <select class="update-mode-select" name="locale" onchange=${e => setLocalePreference(e.target.value)}>
              <option value=${AUTO_LOCALE} selected=${getLocalePreference() === AUTO_LOCALE}>${t('Automatic')}</option>
              ${SUPPORTED_LOCALES.map(locale => this.h`
                <option value=${locale} selected=${getLocalePreference() === locale}>${LOCALE_NAMES[locale]}</option>
              `)}
            </select>
            <icon-chevron-left class="update-mode-select-chevron" props=${{ rotate: 270, size: '16px' }} />
          </div>
        </div>

        <div class="item">
          <div class="item-content">
            <div class="item-title">${t('Auto Update')}</div>
            <div class="item-subtitle">${t('When to install app updates')}</div>
          </div>
          <div class="update-mode-select-wrapper">
            <select class="update-mode-select" name="appUpdateMode" onchange=${(e) => appUpdateMode$(e.target.value)}>
              <option value="always" selected=${updateMode$() === 'always'}>${t('Always')}</option>
              <option value="wifi" selected=${updateMode$() === 'wifi'}>${t('Wi-Fi only')}</option>
              <option value="manual" selected=${updateMode$() === 'manual'}>${t('Manual')}</option>
            </select>
            <icon-chevron-left class="update-mode-select-chevron" props=${{ rotate: 270, size: '16px' }} />
          </div>
        </div>

        <div class=${{
          item: true,
          'app-updates-item': true,
          collapsed: !isManualUpdate$()
        }} onclick=${() => location.pushState({}, '', '/app-updates')}>
          <div class="item-content">
            <div class="item-title">${t('App Updates')}</div>
            <div class="item-subtitle">${t('Check for updates')}</div>
          </div>
          ${showAppUpdatesBadge$() ? this.h`<div class="badge">${appUpdateCount$()}</div>` : ''}
        </div>

        <div class="item">
          <div class="item-content">
            <div class="item-title">${t('Multi-Window Mode')}</div>
            <div class="item-subtitle">${t('Toggle between single and multi-window mode')}</div>
          </div>
          <toggle-switch props=${{
            checked: !isSingleWindow$(),
            onChange: (checked) => isSingleWindow$(!checked)
          }} />
        </div>
      </div>

      <div class="section">
        <div class="section-title">${t('Advanced')}</div>

        <div class="item" style="cursor: default;">
          <div class="input-group" style="width: 100%;">
            <div class="item-title">${t('Credential Vault URL')}</div>
            <div style="display: flex; gap: 8px; align-items: center;">
              <input type="text" style=${{
                flexGrow: 1,
                borderColor: hasVaultUrlError$() ? cssVars.colors.fgError : cssVars.colors.bg3
              }} value=${draftVaultUrl$()} oninput=${handleVaultUrlChange} />
              ${draftVaultUrl$() !== vaultUrl$()
                ? this.h`
                  <button onclick=${saveVaultUrl} style=${`
                    background: ${cssVars.colors.bgAccentPrimary};
                    color: ${cssVars.colors.fgAccent};
                    border: none;
                    border-radius: 4px;
                    width: 40px;
                    height: 40px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                  `}><icon-check props=${{ size: '24px' }} /></button>
                  <button onclick=${cancelVaultUrlChange} style=${`
                    background: ${cssVars.colors.bg2};
                    color: ${cssVars.colors.fg};
                    border: none;
                    border-radius: 4px;
                    width: 40px;
                    height: 40px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                  `}><icon-cancel props=${{ size: '24px' }} /></button>
                `
                : ''}
            </div>
          </div>
        </div>
      </div>
    </div>
  `
})
