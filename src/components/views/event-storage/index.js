import { f, useStore, useTask } from '#f'
import { cssVars, jsVars } from '#assets/styles/theme.js'
import { getT, getEffectiveLocale } from '#i18n/index.js'
import '#shared/back-btn.js'
import { NOSTRDB_QUOTA_SETTINGS_KEY } from '#constants/storage-schema.js'
import {
  DEFAULT_NOSTRDB_QUOTAS, cacheEventLimit, getNostrDbQuotaLimits,
  getNostrDbQuotaUsage, setNostrDbQuotaLimits
} from '#services/idb/nostrdb/quotas.js'
import { MIB, quotaFields, parseQuotaMiB, quotaDraft, draftOverrides, usageSegments, occupancy } from './model.js'
import { eventStorageLocales } from './locales.js'

const t = getT(eventStorageLocales)
const titles = ['Public events', 'Public event cache', 'Personal copies']
const descriptions = [
  'Own events and events from other authors, including cache.',
  'Unreferenced events from other authors. Least recently used events are removed first.',
  'All personal copies share this limit, across authors and contexts.'
]
const segmentTitles = ['Public events outside cache', 'Public event cache', 'Personal copies']
const colors = [cssVars.colors.bgAccentPrimary, cssVars.colors.bgAccentSecondary, cssVars.colors.bgPrimary]
const number = value => value.toLocaleString(getEffectiveLocale(), { maximumFractionDigits: 2 })
const bytes = value => value > 0 && value < 0.005 * MIB
  ? `< ${number(0.01)} MiB`
  : `${number(value / (value >= 1024 * MIB ? 1024 * MIB : MIB))} ${value >= 1024 * MIB ? 'GiB' : 'MiB'}`

f('event-storage', ({ h, s }) => {
  const state = useStore(() => {
    const limits = getNostrDbQuotaLimits()
    return {
      limits$: limits,
      draft$: quotaDraft(limits),
      dirty$: {},
      usage$: null,
      saving$: false,
      status$: '',
      error$: '',
      external$: false,
      disposed: false,
      refreshing: false,
      refreshAgain: false,
      syncLimits (external = false) {
        const next = getNostrDbQuotaLimits()
        const changed = quotaFields.some(key => next[key] !== this.limits$()[key])
        const draft = { ...this.draft$() }
        for (const key of quotaFields) if (!this.dirty$()[key]) draft[key] = String(next[key] / MIB)
        this.limits$(next)
        this.draft$(draft)
        if (external && changed) this.external$(true)
      },
      async refresh () {
        if (this.disposed || document.hidden) return
        if (this.refreshing) { this.refreshAgain = true; return }
        this.refreshing = true
        this.syncLimits(true)
        try {
          const usage = await getNostrDbQuotaUsage()
          if (!this.disposed) {
            this.usage$(usage)
            if (this.error$() === 'usage') this.error$('')
          }
        } catch {
          if (!this.disposed) this.error$('usage')
        } finally {
          this.refreshing = false
          if (this.refreshAgain) {
            this.refreshAgain = false
            this.refresh()
          }
        }
      },
      edit (key, value) {
        this.draft$({ ...this.draft$(), [key]: value })
        this.dirty$({ ...this.dirty$(), [key]: true })
        this.status$('')
      },
      discard () {
        this.dirty$({})
        this.syncLimits()
        this.external$(false)
        this.status$('')
        this.error$('')
      },
      restore () {
        this.draft$(quotaDraft(DEFAULT_NOSTRDB_QUOTAS))
        this.dirty$(Object.fromEntries(quotaFields.map(key => [key, true])))
        this.status$('')
      },
      async save () {
        const overrides = draftOverrides(this.draft$(), this.dirty$())
        if (this.saving$() || !Object.keys(overrides).length || Object.values(overrides).includes(null)) return
        this.saving$(true)
        this.error$('')
        this.status$('')
        try {
          await setNostrDbQuotaLimits(overrides)
          if (!this.disposed) {
            this.discard()
            this.status$('Limits saved.')
            await this.refresh()
          }
        } catch {
          if (!this.disposed) this.error$('save')
        } finally {
          if (!this.disposed) this.saving$(false)
        }
      }
    }
  }, { shouldCache: false })
  useTask(({ cleanup }) => {
    const refresh = () => { state.refresh() }
    const onStorage = event => {
      if (event.storageArea === localStorage && (event.key === NOSTRDB_QUOTA_SETTINGS_KEY || event.key === null)) {
        state.syncLimits(true)
        refresh()
      }
    }
    refresh()
    const interval = setInterval(refresh, 5000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('storage', onStorage)
    cleanup(() => {
      state.disposed = true
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('storage', onStorage)
    })
  })
  const usage = state.usage$()
  const total = usage ? usage.publicBytes + usage.privateBytes : 0
  const segments = usage ? usageSegments(usage) : [0, 0, 0]
  let offset = 0
  const limits = state.limits$()
  const overrides = draftOverrides(state.draft$(), state.dirty$())
  const valid = !Object.values(overrides).includes(null)
  return h`
    <style>${`
      event-storage {
        display: flex !important; flex-direction: column; flex-grow: 1;
        width: 100%; max-width: 900px; height: 100%; min-height: 0;
        background: ${cssVars.colors.bg}; color: ${cssVars.colors.fg};
        .header { height: 55px; flex-shrink: 0; display: flex; align-items: center; padding: 0 10px; border-bottom: 1px solid ${cssVars.colors.bg2}; }
        h1 { margin-left: 10px; font-size: 18rem; font-weight: 500; }
        h2 { font-size: 16rem; font-weight: 600; margin: 0; }
        .content { padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
        .card { background: ${cssVars.colors.bg2}; border-radius: 8px; padding: 18px; }
        .summary { display: flex; align-items: center; gap: 28px; }
        .donut { position: relative; width: 200px; height: 200px; flex-shrink: 0; }
        svg { width: 100%; height: 100%; transform: rotate(-90deg); }
        .center { position: absolute; inset: 44px 26px; display: flex; flex-direction: column; justify-content: center; text-align: center; gap: 5px; }
        .center strong { font-size: 22rem; overflow-wrap: anywhere; }
        .legend { flex: 1; display: flex; flex-direction: column; gap: 16px; }
        .legend-row { display: flex; align-items: center; gap: 10px; }
        .swatch { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
        .legend-name { flex: 1; }
        p, .muted { color: ${cssVars.colors.fg2}; font-size: 14rem; line-height: 1.5; }
        p { margin: 8px 0; }
        .usage { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin: 14px 0 8px; }
        .track { height: 6px; border-radius: 3px; background: ${cssVars.colors.bg3}; overflow: hidden; margin-bottom: 16px; }
        .fill { height: 100%; }
        label { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
        input { width: 170px; max-width: 100%; border: 1px solid ${cssVars.colors.bg3}; border-radius: 6px; background: ${cssVars.colors.bg}; color: ${cssVars.colors.fg}; padding: 9px 12px; font-size: 14rem; }
        .notice, .error { color: ${cssVars.colors.fgError}; }
        .success { color: ${cssVars.colors.fgSuccess}; }
        .actions { display: flex; flex-wrap: wrap; gap: 8px; }
        button { padding: 10px 16px; border-radius: 6px; background: ${cssVars.colors.overlayHover}; color: ${cssVars.colors.fg}; cursor: pointer; font-size: 14rem; }
        button.primary { background: ${cssVars.colors.bgAccentPrimary}; color: ${cssVars.colors.fgAccent}; }
        button:disabled { opacity: .55; cursor: default; }
        button:focus-visible, input:focus-visible { outline: 2px solid ${cssVars.colors.bgAccentPrimary}; outline-offset: 3px; }
        @media ${jsVars.breakpoints.mobile} {
          .summary { flex-direction: column; gap: 20px; }
          .legend { width: 100%; }
          .card { padding: 14px; }
        }
      }
    `}</style>
    <div class="header"><back-btn /><h1>${t('Event storage')}</h1></div>
    <div class="content">
      <div class="card summary" aria-busy=${!usage}>
        <div class="donut">
          ${s`<svg viewBox="0 0 200 200" aria-hidden="true">
            <circle cx="100" cy="100" r="82" fill="none" stroke=${cssVars.colors.bg3} stroke-width="22" />
            ${segments.map((value, i) => {
              const size = total ? value / total * 100 : 0
              const start = offset
              offset += size
              return s`<circle cx="100" cy="100" r="82" fill="none" stroke=${colors[i]} stroke-width="22" pathLength="100" stroke-dasharray=${`${size} ${100 - size}`} stroke-dashoffset=${-start} />`
            })}
          </svg>`}
          <div class="center"><strong>${usage ? bytes(total) : t('Calculating…')}</strong><span class="muted">${usage ? t(total ? 'in events' : 'No events stored') : ''}</span></div>
        </div>
        <div class="legend">${segments.map((value, i) => h({ key: `legend-${i}` })`
          <div class="legend-row"><span class="swatch" style=${`background: ${colors[i]}`}></span><span class="legend-name">${t(segmentTitles[i])}</span><strong>${usage ? bytes(value) : '—'}</strong></div>
        `)}</div>
      </div>
      <p>${t('Limits are shared across all accounts. Only event data is counted; app files and chunk payloads have separate budgets.')}</p>
      ${quotaFields.map((key, i) => {
        const preview = state.dirty$()[key] ? parseQuotaMiB(state.draft$()[key]) : limits[key]
        const used = usage?.[key] ?? 0
        const countKey = key.replace('Bytes', 'Count')
        const isCache = key === 'cacheBytes'
        const over = usage && (used > limits[key] || (isCache && usage.cacheCount > limits.cacheCount))
        const reduction = preview !== null && preview < limits[key]
        return h({ key })`<section class="card" aria-labelledby=${`${key}-title`}>
          <h2 id=${`${key}-title`}>${t(titles[i])}</h2>
          <p>${t(descriptions[i])}</p>
          ${isCache ? h`<p><strong>${t('Included in public event usage.')}</strong></p>` : ''}
          <div class="usage"><strong>${usage ? `${bytes(used)} / ${bytes(limits[key])}` : t('Calculating…')}</strong><span>${usage ? number(usage[countKey]) : '—'}${isCache ? ` / ${number(limits.cacheCount)}` : ''} ${t('events')}</span></div>
          <div class="track" role="progressbar" aria-label=${t(titles[i])} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${occupancy(used, limits[key])} aria-valuetext=${usage ? `${bytes(used)} / ${bytes(limits[key])}` : t('Calculating…')}><div class="fill" style=${`width: ${occupancy(used, limits[key])}%; background: ${colors[i]}`}></div></div>
          ${over ? h`<p class="notice">${t('Above limit')}: ${t(isCache ? 'Automatic cache cleanup is scheduled.' : 'Events are kept. Growth is blocked while above the limit.')}</p>` : ''}
          <label for=${`${key}-input`}>${t('Limit in MiB')}<input id=${`${key}-input`} type="text" inputmode="decimal" value=${state.draft$()[key]} disabled=${state.saving$()} aria-invalid=${preview === null} aria-describedby=${`${key}-hint`} oninput=${event => state.edit(key, event.target.value)} /></label>
          <p id=${`${key}-hint`} class=${preview === null ? 'error' : 'muted'}>${preview === null ? t('Enter a non-negative MiB value within the supported range.') : isCache ? `${number(cacheEventLimit(preview))} ${t('events')}` : ''}</p>
          ${reduction ? h`<p class="notice">${t(isCache ? 'Saving this reduction will schedule automatic cache cleanup.' : 'Events are kept. Growth is blocked while above the limit.')}</p>` : ''}
        </section>`
      })}
      <div role="status" aria-live="polite">
        ${state.external$() ? h`<p>${t('Limits changed in another window. Your edits were kept.')}</p>` : ''}
        ${state.status$() ? h`<p class="success">${t(state.status$())}</p>` : ''}
        ${state.error$() ? h`<p class="error">${t(state.error$() === 'save' ? 'Unable to save limits. Your changes are still here.' : 'Unable to read storage usage.')} <button disabled=${state.saving$()} onclick=${state.error$() === 'save' ? state.save : state.refresh}>${t('Try again')}</button></p>` : ''}
      </div>
      <div class="actions">
        <button class="primary" disabled=${state.saving$() || !valid || !Object.keys(overrides).length} onclick=${state.save}>${t(state.saving$() ? 'Saving…' : 'Save limits')}</button>
        <button disabled=${state.saving$() || !Object.keys(overrides).length} onclick=${state.discard}>${t('Discard changes')}</button>
        <button disabled=${state.saving$()} onclick=${state.restore}>${t('Restore defaults')}</button>
      </div>
    </div>
  `
})
