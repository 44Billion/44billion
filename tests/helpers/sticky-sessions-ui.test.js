import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFile } from 'node:fs/promises'

describe('sticky sessions UI', () => {
  it('wires the settings toggle, confirmation and sessions screen', async () => {
    const settings = await readFile(
      new URL('../../src/components/views/settings/index.js', import.meta.url),
      'utf8'
    )
    const screen = await readFile(
      new URL('../../src/components/zones/screen/index.js', import.meta.url),
      'utf8'
    )
    const router = await readFile(
      new URL('../../src/components/zones/multi-napp/router.js', import.meta.url),
      'utf8'
    )

    assert.match(settings, /config_stickySessions/)
    assert.match(settings, /requestConfirmation/)
    assert.match(settings, /purgeStickySessions/)
    assert.match(settings, /sticky-sessions/)
    assert.match(settings, /maxWidth: '630px'/)
    assert.match(settings, /stickyToggleReset/)
    assert.match(screen, /\/sticky-sessions/)
    assert.match(screen, /syncCanonicalOrder/)
    assert.match(screen, /visibilitychange/)
    assert.match(router, /sticky-sessions/)

    const confirmation = await readFile(
      new URL('../../src/components/zones/confirmation-dialog/index.js', import.meta.url),
      'utf8'
    )
    assert.match(confirmation, /maxWidth\$/)
  })

  it('wires the toolbar badge, the view actions and the pre-render hydration', async () => {
    const menu = await readFile(
      new URL('../../src/components/zones/screen/menus/toolbar-more-menu.js', import.meta.url),
      'utf8'
    )
    const view = await readFile(
      new URL('../../src/components/views/sticky-sessions/index.js', import.meta.url),
      'utf8'
    )
    const app = await readFile(
      new URL('../../src/components/app.js', import.meta.url),
      'utf8'
    )

    assert.match(menu, /useStickySessionBadgeCount/)
    assert.doesNotMatch(menu, /sticky-sessions/)
    assert.match(menu, /showUpdateIndicator\$\(\) \|\| stickyBadgeCount\$\(\) > 0/)
    assert.match(view, /window\.open/)
    assert.match(view, /requestStickySessionDelete/)
    assert.match(view, /duplicateStickySession/)
    assert.match(view, /t\('Duplicate'\)/)
    assert.match(view, /pendingRestore\$/)
    assert.match(view, /handlePrimaryAction/)
    assert.match(view, /disabled: isPending/)
    assert.match(view, /listSessionWorkspaceAppGroups/)
    assert.match(view, /ws\.openKeys/)
    assert.match(view, /getEffectiveLocale\(\)/)
    assert.match(view, /workspace-label/)
    assert.match(view, /a-avatar/)
    assert.match(view, /openCount/)
    assert.match(view, /bg3Primary/)
    assert.match(app, /claimAndHydrateStickySession/)
    assert.match(app, /initTabWorkspaceOrder/)
    assert.match(app, /resetClonedState/)

    const snapshotter = await readFile(
      new URL('../../src/components/hooks/use-sticky-session-snapshotter.js', import.meta.url),
      'utf8'
    )
    assert.match(snapshotter, /ackStickySessionDeletion/)
    assert.match(snapshotter, /local_stickySessionDeletions\$/)
    assert.match(snapshotter, /session_appByKey_\$\{appKey\}_route\$/)

    const appPage = await readFile(
      new URL('../../src/scripts/app-page.txt.js', import.meta.url),
      'utf8'
    )
    assert.match(appPage, /reportRouteChanges/)
    assert.match(appPage, /history\.pushState/)
    assert.match(appPage, /APP_ROUTE_CHANGED/)

    const appBridge = await readFile(
      new URL('../../src/helpers/window-message/app-bridge.js', import.meta.url),
      'utf8'
    )
    assert.match(appBridge, /case 'APP_ROUTE_CHANGED'/)
    assert.match(appBridge, /session_appByKey_\$\{appKey\}_route/)
  })
})
