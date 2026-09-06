import { f, useStore, useTask } from '#f'
import { useAppPersona } from '#hooks/use-app-persona.js'
import { cssVars } from '#assets/styles/theme.js'
import { personaT as t } from '#i18n/personas.js'
import '#shared/avatar.js'
import '#shared/icons/icon-users-group.js'
import '#shared/icons/icon-users-plus.js'
import '#shared/icons/icon-check.js'

f('app-persona-icon', ({ h, props }) => {
  const avatarProps = useStore(() => ({
    pk$: props.userPk$,
    size$ () { return props.isDefaultWidgetUser$?.() ? '26px' : (props.size ?? '16px') }
  }))
  const size = avatarProps.size$()
  const clipAvatar = !props.personaId$() && !props.toolbar && !props.isDefaultWidgetUser$?.()
  return h`<span aria-hidden='true' style=${`display:grid;place-items:center;width:${size};height:${size};flex-shrink:0;${clipAvatar ? 'border-radius:50%;overflow:hidden;' : ''}`}>
    ${props.personaId$()
      ? h`<icon-users-group props=${{ size: '16px' }} />`
      : props.toolbar
        ? h`<icon-users-plus props=${{ size: '16px' }} />`
        : h`<a-avatar props=${avatarProps} />`}
  </span>`
})

f('app-persona-options', ({ h, props }) => {
  const persona = useAppPersona(props)
  const store = useStore({ root$: null })
  useTask(({ track }) => {
    const root = track(() => store.root$())
    root?.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true })
  }, { after: 'rendering' })
  const onKeyDown = event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...store.root$().querySelectorAll('[role="menuitemradio"]')]
    const index = items.indexOf(document.activeElement)
    let next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = items.length - 1
    items[next]?.focus()
  }
  return h`<div class='app-persona-options' ref=${store.root$} role='menu' aria-label=${t('Switch User')} onkeydown=${onKeyDown} onpointerdown=${event => event.stopPropagation()}>
    <style>${`
      app-persona-options .app-persona-options {
        min-width: 180px;
        max-width: min(320px, calc(100vw - 24px));
        .persona-option {
          display: flex; align-items: center; gap: 10px;
          box-sizing: border-box; width: 100%; padding: 12px;
          background: transparent; color: inherit; border: 0;
          text-align: start; cursor: pointer;
        }
        .persona-option:hover, .persona-option:focus-visible { background-color: ${cssVars.colors.bg3}; }
        .persona-option:focus-visible { outline: 2px solid ${cssVars.colors.bgAccentPrimary}; outline-offset: -2px; }
        .persona-label { flex: 1; overflow-wrap: anywhere; }
        .persona-check { width: 16px; height: 16px; flex-shrink: 0; }
      }
    `}</style>
    ${persona.options$().map(option => h`<button
      type='button' class='persona-option' role='menuitemradio'
      data-persona-id=${option.id ?? ''}
      aria-checked=${String(option.id === persona.selectedId$())}
      onclick=${() => { persona.select(option.id); props.onSelect() }}
    >
      <app-persona-icon props=${{ personaId$: () => option.id, userPk$: persona.userPk$ }} />
      <span class='persona-label'>${option.label}</span>
      <span class='persona-check'>${option.id === persona.selectedId$() ? h`<icon-check props=${{ size: '16px' }} />` : ''}</span>
    </button>`)}
  </div>`
})
