import { f, useSignal, useTask } from '#f'
import { cssVars } from '#assets/styles/theme.js'
import { nappletSettings$, nappletNotices$, nappletBadges$, nappletMedia$, dismissNappletNotice } from '#services/napplets/ui.js'
import { nappletT as t } from '#i18n/napplets.js'

f('napplet-host-ui', function () {
  const ref$ = useSignal(null)
  const draft$ = useSignal({})
  const error$ = useSignal('')
  useTask(({ track }) => {
    const settings = track(() => nappletSettings$())
    draft$(structuredClone(settings?.context.values || {}))
    error$('')
  })
  useTask(({ track }) => {
    const [dialog, settings] = track(() => [ref$(), nappletSettings$()])
    if (dialog && settings && !dialog.open) dialog.showModal()
    else if (dialog?.open && !settings) dialog.close()
  }, { after: 'rendering' })
  const settings = nappletSettings$()
  const save = event => {
    event.preventDefault()
    if (error$()) return
    try { settings.context.commit(draft$()); nappletSettings$(null) } catch (error) { error$(error.message) }
  }
  const edit = (key, value) => { error$(''); draft$(values => ({ ...values, [key]: value })) }
  const badges = Object.values(nappletBadges$()).filter(badge => badge.count > 0)
  return this.h`
    <style>${/* css */`
      napplet-host-ui {
        .settings { margin: auto; width: min(560px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 20px; border: 1px solid ${cssVars.colors.bg3}; border-radius: 12px; background: ${cssVars.colors.bg}; color: ${cssVars.colors.fg}; font-size: 14rem; overflow: auto; }
        .settings::backdrop { background: ${cssVars.colors.modalBackdrop}; }
        h2 { font-size: 18rem; margin-bottom: 16px; }
        label { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
        input, select, textarea { padding: 8px; border: 1px solid ${cssVars.colors.bg3}; border-radius: 6px; background: ${cssVars.colors.bg2}; color: ${cssVars.colors.fg}; font-size: 14rem; }
        input[type=checkbox] { align-self: flex-start; }
        textarea { min-height: 100px; }
        .help { color: ${cssVars.colors.fgMuted}; line-height: 1.5; }
        .actions { display: flex; justify-content: flex-end; gap: 8px; }
        button { padding: 8px 12px; border-radius: 6px; background: ${cssVars.colors.bg3}; font-size: 14rem; }
        .primary { background: ${cssVars.colors.bgAccentPrimary}; color: ${cssVars.colors.fgAccent}; }
        .error { color: ${cssVars.colors.fgError}; margin-bottom: 12px; }
        .notices { position: fixed; right: 16px; bottom: 16px; z-index: 10000; display: flex; flex-direction: column; gap: 8px; width: min(360px, calc(100vw - 32px)); pointer-events: none; }
        .notice { pointer-events: auto; padding: 16px; border: 1px solid ${cssVars.colors.bg3}; border-radius: 8px; background: ${cssVars.colors.bg2}; color: ${cssVars.colors.fg}; font-size: 14rem; box-shadow: 0 4px 16px ${cssVars.colors.shadow}; }
        .notice p { line-height: 1.5; margin-bottom: 8px; }
        .badge { color: ${cssVars.colors.fg2}; font-size: 12rem; }
        .players { max-height: 35dvh; overflow: auto; pointer-events: auto; }
        audio, video { display: block; width: 100%; max-height: 200px; margin-bottom: 8px; }
      }
    `}</style>
    <dialog class='settings' ref=${ref$} oncancel=${() => nappletSettings$(null)}>
      ${settings
? this.h`<form onsubmit=${save}>
        <h2>${settings.name} · ${t('Settings')}</h2>
        ${Object.entries(settings.context.schema.properties || {}).map(([key, field]) => this.h({ key })`<label>
          <span>${field.title || key}</span>
          ${field.description ? this.h`<span class='help'>${field.description}</span>` : ''}
          ${field.enum
? this.h`<select onchange=${event => edit(key, field.enum[Number(event.target.value)])}>${field.enum.map((value, index) => this.h`<option value=${String(index)} selected=${JSON.stringify(draft$()[key]) === JSON.stringify(value)}>${String(value)}</option>`)}</select>`
            : field.type === 'boolean'
? this.h`<input type='checkbox' checked=${draft$()[key] === true} onchange=${event => edit(key, event.target.checked)} />`
              : field.type === 'object' || field.type === 'array'
? this.h`<textarea onchange=${event => { try { edit(key, JSON.parse(event.target.value)); error$('') } catch (error) { error$(error.message) } }}>${JSON.stringify(draft$()[key] ?? (field.type === 'array' ? [] : {}), null, 2)}</textarea>`
                : this.h`<input type=${field.type === 'number' || field.type === 'integer' ? 'number' : field['x-napplet-secret'] ? 'password' : 'text'} value=${draft$()[key] ?? ''} oninput=${event => edit(key, field.type === 'number' || field.type === 'integer' ? Number(event.target.value) : event.target.value)} />`}
        </label>`)}
        ${error$() ? this.h`<p class='error' role='alert'>${error$()}</p>` : ''}
        <div class='actions'><button type='button' onclick=${() => nappletSettings$(null)}>${t('Cancel')}</button><button class='primary' type='submit'>${t('Save')}</button></div>
      </form>`
: ''}
    </dialog>
    <div class='notices' aria-live='polite'>
      <div class='players'>${Object.values(nappletMedia$()).flatMap(group => group.sessions.map(session => this.h({ key: session.sessionId })`<div class='notice'>
        <p>${session.metadata?.title || group.name}</p>
        ${group.service.getElement(session.sessionId) || ''}
        <div class='actions'><button onclick=${() => group.service.command(session.sessionId, { action: 'play' })}>${t('Play')}</button><button onclick=${() => group.service.command(session.sessionId, { action: 'pause' })}>${t('Pause')}</button><button onclick=${() => group.service.retire(session.sessionId, 'user')}>${t('Close')}</button></div>
      </div>`))}</div>
      ${badges.map(badge => this.h`<div class='badge'>${badge.name}: ${badge.count}</div>`)}
      ${nappletNotices$().map(notice => this.h({ key: notice.notificationId })`<div class='notice'>
        <p class='help'>${notice.name}</p><p><strong>${notice.message.title}</strong></p><p>${notice.message.body || ''}</p>
        <div class='actions'>${(notice.message.actions || []).slice(0, 3).map(action => this.h`<button onclick=${() => notice.emit({ type: 'notify.action', notificationId: notice.notificationId, actionId: action.id })}>${action.label}</button>`)}<button onclick=${() => dismissNappletNotice(notice.windowId, notice.notificationId, true)}>${t('Close')}</button></div>
      </div>`)}
    </div>
  `
})
