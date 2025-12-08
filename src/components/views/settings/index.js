import { f, useSignal, useTask } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'
import useLocation from '#hooks/use-location.js'
import { cssVars } from '#assets/styles/theme.js'
import '#shared/back-btn.js'
import '#shared/toggle-switch.js'
import '#shared/icons/icon-check.js'
import '#shared/icons/icon-cancel.js'
import { run } from '#services/idb/browser/index.js'

f('a-settings', function () {
  const storage = useWebStorage(localStorage)
  const {
    config_isSingleWindow$: isSingleWindow$,
    config_vaultUrl$: vaultUrl$
  } = storage
  const location = useLocation()

  const updatesCount$ = useSignal(0)
  const draftVaultUrl$ = useSignal(vaultUrl$())

  useTask(async () => {
    try {
      const bundles = (await run('getAll', [], 'bundles')).result
      const count = bundles.filter(b => b.u).length // b.u is hasUpdate
      updatesCount$(count)
    } catch (e) {
      console.error('Failed to check updates', e)
    }
  })

  const handleVaultUrlChange = (e) => {
    draftVaultUrl$(e.target.value)
  }

  const saveVaultUrl = () => {
    vaultUrl$(draftVaultUrl$())
  }

  const cancelVaultUrlChange = () => {
    draftVaultUrl$(vaultUrl$())
  }

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
    `}</style>

    <div class="header">
      <back-btn />
      <div class="title">Settings</div>
    </div>

    <div class="content">
      <div class="section">
        <div class="section-title">General</div>

        <div class="item" onclick=${() => location.pushState({}, '', '/napp-updates')}>
          <div class="item-content">
            <div class="item-title">Napp Updates</div>
            <div class="item-subtitle">Check for updates</div>
          </div>
          ${updatesCount$() > 0 ? this.h`<div class="badge">${updatesCount$()}</div>` : ''}
        </div>

        <div class="item">
          <div class="item-content">
            <div class="item-title">Multi-Window Mode</div>
            <div class="item-subtitle">Toggle between single and multi-window mode</div>
          </div>
          <toggle-switch props=${{
            checked: !isSingleWindow$(),
            onChange: (checked) => isSingleWindow$(!checked)
          }} />
        </div>
      </div>

      <div class="section">
        <div class="section-title">Advanced</div>

        <div class="item" style="cursor: default;">
          <div class="input-group" style="width: 100%;">
            <div class="item-title">Credential Vault URL</div>
            <div style="display: flex; gap: 8px; align-items: center;">
              <input type="text" style="flex-grow: 1;" value=${draftVaultUrl$()} oninput=${handleVaultUrlChange} />
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
