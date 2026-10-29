import { f, useGlobalStore, useSignal, useTask, useWebStorage } from '#f'
import { useActiveWorkspaceOrder } from '#hooks/use-active-workspace-order.js'
import { getAppIconMonogram } from '#helpers/app-icon.js'
import { createNappletIconUrl, loadNappletAuthors, nappletAuthorLabel } from '#services/napplets/catalog-metadata.js'
import { cssVars } from '#assets/styles/theme.js'
import { nappletReference } from '#helpers/napplet.js'
import { queryNappletCatalog } from '#services/napplets/index.js'
import { nappletIntentEntry } from '#services/napplets/intents.js'
import { nappletIntentHandoffs$ } from '#services/napplets/ui.js'
import '#shared/back-btn.js'
import { nappletT as t } from '#i18n/napplets.js'

f('napplet-catalog', function ({ props }) {
  const { openApp } = useGlobalStore('useAppRouter')
  const navigation = useGlobalStore('nappletNavigation')
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const { order$ } = useActiveWorkspaceOrder(storage, tabStorage)
  useTask(({ track }) => {
    const [handoff, userPk] = track(() => [nappletIntentHandoffs$()[props.wsKey], storage[`session_workspaceByKey_${props.wsKey}_userPk$`]()])
    if (handoff && handoff.userPk !== userPk) nappletIntentHandoffs$(value => { const next = { ...value }; delete next[props.wsKey]; return next })
  })
  useTask(({ cleanup }) => {
    cleanup(() => nappletIntentHandoffs$(value => { const next = { ...value }; delete next[props.wsKey]; return next }))
  })
  const profiles$ = useSignal({})
  const icons$ = useSignal({})
  const entries$ = useSignal([])
  const loading$ = useSignal(true)
  const error$ = useSignal('')
  const busy$ = useSignal('')
  const reference$ = useSignal('')
  const search$ = useSignal('')
  const revision$ = useSignal(0)
  useTask(async ({ track, cleanup }) => {
    const handoff = track(() => { revision$(); return nappletIntentHandoffs$()[props.wsKey] })
    const ac = new AbortController()
    cleanup(() => ac.abort())
    loading$(true)
    error$('')
    try {
      const entries = await queryNappletCatalog({ signal: ac.signal, convention: handoff?.request.convention })
      if (ac.signal.aborted) return
      entries$(entries)
      profiles$({})
      icons$({})
      const urls = new Set()
      cleanup(() => { for (const url of urls) URL.revokeObjectURL(url) })
      const authors = loadNappletAuthors(entries.map(entry => entry.event.pubkey), { signal: ac.signal })
        .then(profiles => { if (!ac.signal.aborted) profiles$(profiles) }).catch(() => {})
      const queue = entries.filter(entry => entry.manifest.icon)
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length && !ac.signal.aborted) {
          const entry = queue.shift()
          try {
            const url = await createNappletIconUrl(entry.manifest, { signal: ac.signal })
            if (ac.signal.aborted) { if (url) URL.revokeObjectURL(url); return }
            if (url) {
              urls.add(url)
              icons$(value => ({ ...value, [entry.appId]: url }))
            }
          } catch {}
        }
      })
      // Metadata is optional: display the catalog immediately, then enrich it.
      loading$(false)
      await Promise.all([authors, ...workers])
    } catch (error) { if (!ac.signal.aborted) error$(error.message) } finally { if (!ac.signal.aborted) loading$(false) }
  })
  const open = async reference => {
    if (busy$()) return
    busy$(reference)
    error$('')
    navigation.error$('')
    try {
      const handoff = nappletIntentHandoffs$()[props.wsKey]
      if (handoff && storage[`session_workspaceByKey_${props.wsKey}_userPk$`]() !== handoff.userPk) throw new Error('ACCOUNT_ACCESS_REVOKED')
      await openApp(`/napplet/${encodeURIComponent(reference.replace(/^nostr:/, ''))}`, props.wsKey)
      if (handoff && nappletIntentHandoffs$()[props.wsKey] === handoff) {
        const entry = entries$().find(entry => nappletReference(entry.event) === reference)
        if (!entry) throw new Error('Unsupported intent handler')
        await handoff.continue(entry.catalogId)
        nappletIntentHandoffs$(value => { const next = { ...value }; delete next[props.wsKey]; return next })
      }
    } catch (error) { error$(error.message) } finally { busy$('') }
  }
  const wsKey = props.wsKey || order$()[0]
  const installed = new Set(wsKey
    ? [
        ...(storage[`session_workspaceByKey_${wsKey}_pinnedAppIds$`]() || []),
        ...(storage[`session_workspaceByKey_${wsKey}_unpinnedAppIds$`]() || [])
      ]
    : [])
  const handoff = nappletIntentHandoffs$()[props.wsKey]
  const search = search$().toLocaleLowerCase()
  const entries = entries$().filter(entry => !handoff || Object.values(nappletIntentEntry(entry.event).archetypes).some(role => role.contracts.some(contract => contract.convention === handoff.request.convention))).filter(({ manifest }) => `${manifest.title || ''} ${manifest.description || ''} ${manifest.dTag}`.toLocaleLowerCase().includes(search))
  return this.h`
    <style>${/* css */`
      napplet-catalog {
        display: flex !important;
        flex: 1;
        flex-direction: column;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        color: ${cssVars.colors.fg};
        background: ${cssVars.colors.bg};
        font-size: 14rem;
        line-height: 1.5;

        .heading {
          display: flex; align-items: center; gap: 10px;
          width: 100%; max-width: 1200px; min-height: 55px;
          margin-inline: auto; padding: 8px 16px; flex-shrink: 0;
          border-bottom: 1px solid ${cssVars.colors.bg2};
        }
        h1 { font-size: 18rem; font-weight: 500; line-height: 1.3; }
        .scroll-area { flex: 1; min-height: 0; overflow-y: auto; }
        .content {
          display: flex; flex-direction: column; gap: 16px;
          width: 100%; max-width: 1200px; margin-inline: auto; padding: 20px;
        }
        p { line-height: 1.5; }
        .intro { color: ${cssVars.colors.fg2}; }
        .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
        input {
          flex: 1 1 200px; min-width: 0; width: 100%; min-height: 42px;
          padding: 10px 12px; border-radius: 6px;
          border: 1px solid ${cssVars.colors.bg3};
          background: ${cssVars.colors.bg2}; color: ${cssVars.colors.fg};
          font-size: 14rem; line-height: 1.4;
        }
        input::placeholder { color: ${cssVars.colors.fgMuted}; opacity: 1; }
        input:focus-visible, button:focus-visible {
          outline: 2px solid ${cssVars.colors.bgAccentPrimary}; outline-offset: 2px;
        }
        button {
          display: inline-flex; align-items: center; justify-content: center;
          min-height: 42px; padding: 10px 16px; border-radius: 6px;
          background: ${cssVars.colors.overlayHover}; color: ${cssVars.colors.fg};
          font-size: 14rem; line-height: 1.4; cursor: pointer;
        }
        button:hover:not(:disabled) { background: ${cssVars.colors.overlaySelected}; }
        button:disabled { opacity: 0.5; cursor: default; }
        .primary { background: ${cssVars.colors.bgAccentPrimary}; color: ${cssVars.colors.fgAccent}; }
        .primary:hover:not(:disabled) { background: ${cssVars.colors.bgAccentPrimary}; filter: brightness(1.1); }
        .heading back-btn button { min-height: 36px; width: 36px; padding: 0; background: none; }
        .catalog { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 16px; }
        article {
          display: flex; flex-direction: column; gap: 8px; min-width: 0;
          padding: 16px; background: ${cssVars.colors.bg2};
          border: 1px solid ${cssVars.colors.mg2}; border-radius: 8px;
          overflow-wrap: anywhere;
        }
        .app-summary { display: flex; align-items: center; gap: 12px; min-width: 0; }
        .app-icon {
          display: flex; align-items: center; justify-content: center;
          width: 64px; height: 64px; flex-shrink: 0; overflow: hidden;
          border-radius: 14px; background: ${cssVars.colors.bg3}; color: ${cssVars.colors.fg2};
          font-size: 22rem; font-weight: 600;
        }
        .app-icon img { display: block; width: 100%; height: 100%; object-fit: contain; }
        .app-info { min-width: 0; flex: 1; }
        .author { margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: ${cssVars.colors.fg2}; }
        .description {
          display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5;
          line-clamp: 5; overflow: hidden; line-height: 1.5; max-height: 105px;
          margin-top: 4px; color: ${cssVars.colors.fg2};
        }
        .card-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: auto; padding-top: 8px; }
        .compatibility { font-size: 12rem; line-height: 1.4; color: ${cssVars.colors.fgMuted}; }
        article button { flex-shrink: 0; min-width: 84px; }
        h2 { font-size: 18rem; line-height: 1.3; }
        .error { color: ${cssVars.colors.fgError}; }
        .muted { color: ${cssVars.colors.fgMuted}; }
        @media (max-width: 480px) {
          .content { padding: 12px; }
          .controls button { flex: 1 1 auto; }
        }
      }
    `}</style>
    ${props.windowed ? '' : this.h`<div class='heading'><back-btn /><h1>${t('Napplets')}</h1></div>`}
    <div class='scroll-area'><div class='content'>
    <p class='intro'>${t('Install sandboxed napplets and open them in your workspace.')}</p>
    ${handoff ? this.h`<p>${t('Find a napplet for')} <strong>${handoff.request.convention}</strong> <button onclick=${() => nappletIntentHandoffs$(value => { const next = { ...value }; delete next[props.wsKey]; return next })}>${t('Cancel')}</button></p>` : ''}
    ${handoff
? ''
: this.h`<form class='controls' onsubmit=${event => { event.preventDefault(); open(reference$().trim()) }}>
      <input aria-label=${t('Napplet reference')} placeholder=${t('Paste a napplet naddr or nevent')} value=${reference$()} oninput=${event => reference$(event.target.value)} required />
      <button class='primary' type='submit' disabled=${!!busy$()}>${t('Open napplet')}</button>
    </form>`}
    <div class='controls'>
      <input type='search' aria-label=${t('Search napplets')} placeholder=${t('Search napplets')} value=${search$()} oninput=${event => search$(event.target.value)} />
      <button onclick=${() => revision$(n => n + 1)} disabled=${loading$()}>${t('Refresh')}</button>
    </div>
    ${error$() || navigation.error$() ? this.h`<p class='error' role='alert'>${error$() || navigation.error$()}</p>` : ''}
    ${loading$() ? this.h`<p role='status'>${t('Loading napplets…')}</p>` : entries.length ? '' : this.h`<p>${t('No napplets found. You can open one using its reference above.')}</p>`}
    <div class='catalog'>${entries.map(entry => this.h({ key: entry.appId })`
      <article>
        <div class='app-summary'>
          <div class='app-icon' aria-hidden='true'>
            ${icons$()[entry.appId]
              ? this.h`<img src=${icons$()[entry.appId]} alt='' onerror=${() => icons$(value => ({ ...value, [entry.appId]: null }))} />`
              : getAppIconMonogram(entry.appId, entry.manifest.title || entry.manifest.dTag).label}
          </div>
          <div class='app-info'>
            <h2>${entry.manifest.title || entry.manifest.dTag || t('Napplet')}</h2>
            <p class='author' title=${entry.event.pubkey}>${nappletAuthorLabel(entry.event.pubkey, profiles$())}</p>
          </div>
        </div>
        <p class='description'>${entry.manifest.description || ''}</p>
        <div class='card-actions'>
          <span class='compatibility' title=${entry.missing.length ? `${t('Requires unsupported capabilities:')} ${entry.missing.join(', ')}` : ''}>${entry.missing.length ? t('Some features may be unavailable') : ''}</span>
          <button class='primary' disabled=${!!busy$()} onclick=${() => open(nappletReference(entry.event))}>${busy$() === nappletReference(entry.event) ? t('Opening…') : installed.has(entry.appId) ? (handoff ? t('Open and continue') : t('Open')) : (handoff ? t('Install and continue') : t('Install'))}</button>
        </div>
      </article>
    `)}</div>
    </div></div>
  `
})
