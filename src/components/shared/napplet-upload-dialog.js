import { f, useSignal, useTask } from '#f'
import { cssVars } from '#assets/styles/theme.js'
import { nappletUploadChoice$ } from '#services/napplets/ui.js'
import { normalizeUploadServers } from '#services/napplets/uploads.js'
import { nappletT as t } from '#i18n/napplets.js'

f('napplet-upload-dialog', function () {
  const ref$ = useSignal(null)
  const selected$ = useSignal([])
  const server$ = useSignal('')
  const error$ = useSignal('')
  useTask(({ track }) => {
    const choice = track(() => nappletUploadChoice$())
    selected$(choice?.servers || [])
    server$('')
    error$('')
  })
  useTask(({ track }) => {
    const [dialog, choice] = track(() => [ref$(), nappletUploadChoice$()])
    if (dialog && choice && !dialog.open) dialog.showModal()
    else if (dialog?.open && !choice) dialog.close()
  }, { after: 'rendering' })
  const choice = nappletUploadChoice$()
  return this.h`
    <style>${/* css */`
      napplet-upload-dialog {
        dialog { margin: auto; width: min(520px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; padding: 20px; border: 1px solid ${cssVars.colors.bg3}; border-radius: 12px; background: ${cssVars.colors.bg}; color: ${cssVars.colors.fg}; font-size: 14rem; }
        dialog::backdrop { background: ${cssVars.colors.modalBackdrop}; }
        h2 { font-size: 18rem; margin-bottom: 12px; }
        p { margin-bottom: 12px; overflow-wrap: anywhere; }
        label { display: block; margin: 12px 0; overflow-wrap: anywhere; }
        input[type=url] { width: 100%; padding: 8px; background: ${cssVars.colors.bg2}; color: ${cssVars.colors.fg}; border: 1px solid ${cssVars.colors.bg3}; }
        button { padding: 8px 12px; background: ${cssVars.colors.bg3}; border-radius: 6px; font-size: 14rem; }
        .actions { display: flex; justify-content: flex-end; gap: 8px; }
        .error { color: ${cssVars.colors.fgError}; }
      }
    `}</style>
    <dialog ref=${ref$} aria-label=${t('Upload file')} oncancel=${event => { event.preventDefault(); choice?.finish() }}>
      ${choice
? this.h`
        <h2>${choice.name} · ${t('Upload file')}</h2>
        <p>${choice.filename} · ${Math.ceil(choice.size / 1024)} KiB</p>
        <p>${t('This file will be publicly accessible.')}</p>
        <p>${choice.pubkey}</p>
        ${choice.servers.map(server => this.h`<label><input type='checkbox' checked=${selected$().includes(server)} onchange=${event => selected$(values => event.target.checked ? [...values, server] : values.filter(value => value !== server))} /> ${server}</label>`)}
        <label>${t('Additional Blossom server')}<input type='url' placeholder='https://' value=${server$()} oninput=${event => server$(event.target.value)} /></label>
        ${error$() ? this.h`<p class='error' role='alert'>${error$()}</p>` : ''}
        <div class='actions'><button onclick=${() => choice.finish()}>${t('Cancel')}</button><button onclick=${() => {
          const extra = server$().trim()
          const servers = normalizeUploadServers([...selected$(), ...(extra ? [extra] : [])])
          if (!servers.length || (extra && !normalizeUploadServers([extra]).length)) { error$(t('Choose a public HTTPS Blossom server.')); return }
          choice.finish(servers)
        }}>${t('Upload file')}</button></div>
      `
: ''}
    </dialog>
  `
})
