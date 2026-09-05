// Actual widget grid, menu, gesture client, persistence and metadata hooks.
// The runner substitutes the network bridge and external dialogs only.
import { f, useStore, useGlobalStore, useGlobalSignal, useWebStorage } from '#f'
import { useInitInstanceMetadata, useInstanceMetadataSurface } from '#hooks/use-instance-metadata.js'
import { instanceMetadata } from '#services/instance-metadata/index.js'
import { createWidgetDragClient } from '#helpers/window-message/widget-drag-client.js'
import { cssStrings } from '#assets/styles/theme.js'
import { screenStyle, backgroundStyle } from 'fixture-screen-style'
import '#zones/screen/widgets/index.js'

window.fixture = { instanceMetadata, createWidgetDragClient, starts: {}, registrations: {} }
f('pin-test-screen', ({ h }) => {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const state = useStore({ system$: false, window$: false, appRef$: null })
  const manual$ = useGlobalSignal('widgetsRevealActive', false)
  const automatic$ = useGlobalSignal('widgetEditReveal', null)
  useGlobalStore('useAppRouter', { openApp () {} })
  const reveal = () => manual$() || !!automatic$()
  useInitInstanceMetadata({ storage, isSystemRoute: () => state.system$() && !automatic$(), revealWidgets: reveal })
  useInstanceMetadataSurface('window', () => ({ element: state.appRef$(), isWidget: false, eligible: state.window$(), contentVisible: true }))
  Object.assign(window.fixture, { storage, tabStorage, state, manual$, automatic$ })
  return h`<div id='screen' class=${{
    'theme-default': true,
    'system-route-active': state.system$(),
    'widgets-reveal-active': reveal(),
    'widgets-edit-reveal-active': !!automatic$()
  }}>
    <style>${cssStrings.defaultTheme}</style>
    <style>${screenStyle(state.system$())}</style>
    <style>
      #screen { app-window .scope_khjha3 { position: absolute; inset: 0; z-index: 2; }

      }
      body { margin: 0; }
    </style>
    <div id='workspaces'>
      <div id='windows'>
        <widgets-layer />
        <app-window><div id='app-cover' ref=${state.appRef$} class='scope_khjha3 open' style=${`display:${state.window$() ? 'block' : 'none'}`}></div></app-window>
        <div id='windows-background' style=${backgroundStyle}></div>
      </div>
      <div id='system-views'></div>
    </div>
    <div id='unified-toolbar'></div>
  </div>`
})
document.body.insertAdjacentHTML('beforeend', '<pin-test-screen></pin-test-screen>')
