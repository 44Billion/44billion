import { f } from '#f'
import { getT, SUPPORTED_LOCALES } from '#i18n/index.js'
import { cssVars } from '#assets/styles/theme.js'
import '#shared/icons/icon-topology-star.js'
import { isRelayPoolEnabled, setRelayPoolEnabled } from '#services/relay-pool/launcher.js'

const en = {
  on: 'Relay pool: on (reload to disable)',
  off: 'Relay pool: off (reload to enable)'
}
const pt = {
  on: 'Relay pool: ligada (recarregue para desligar)',
  off: 'Relay pool: desligada (recarregue para ligar)'
}
const translate = getT(Object.fromEntries(Object.entries(en).map(([key, text]) => [text,
  Object.fromEntries(SUPPORTED_LOCALES.map(locale => [locale, locale === 'pt-BR' ? pt[key] : text]))
])))
const t = key => translate(en[key])

// Development-only kill switch: flips the persisted flag and reloads.
f('local-dev-relay-pool-button', ({ h }) => {
  const enabled = isRelayPoolEnabled()
  const toggle = () => {
    setRelayPoolEnabled(!enabled)
    location.reload()
  }
  return h`<div class='local-dev-relay-pool'>
    <button type='button' onclick=${toggle}>
      <span class='relay-pool-icon' aria-hidden='true'><icon-topology-star props=${{ size: '16px' }} /></span>
      <span class='relay-pool-label'>${enabled ? t('on') : t('off')}</span>
    </button>
    <style>${`local-dev-relay-pool-button .local-dev-relay-pool {
      button { display: flex; align-items: center; width: 100%; border: 0; background: transparent; color: inherit; padding: 0; text-align: start; cursor: pointer; }
      .relay-pool-icon { display: flex; flex: 0 0 16px; margin: 10px; }
      .relay-pool-label { flex: 1; min-height: 30px; padding: 10px 10px 10px 3px; }
      button:active { background: ${cssVars.colors.bg2}; }
      button:focus-visible { outline: 2px solid ${cssVars.colors.bgAccentPrimary}; }
    }`}</style>
  </div>`
})
