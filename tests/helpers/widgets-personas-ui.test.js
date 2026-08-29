import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFile } from 'node:fs/promises'

describe('widgets and personas wiring', () => {
  it('exposes the persona APIs from the app page', async () => {
    const appPage = await readFile(
      new URL('../../src/scripts/app-page.txt.js', import.meta.url),
      'utf8'
    )
    assert.match(appPage, /getPersonaPublicKeys/)
    assert.match(appPage, /getWindowNostrFor/)
    assert.match(appPage, /WINDOW_NAPP/)
    assert.match(appPage, /userPk: pubkey/)
    assert.match(appPage, /AUTO_FIT_MIN_ZOOM/)
    assert.match(appPage, /startAutoFit/)
    assert.match(appPage, /setMinWidth/)
    assert.match(appPage, /startViewTransition/)
    assert.match(appPage, /computeAutoFitZoom/)
    assert.match(appPage, /getOpaqueAutoFitBackground/)
    assert.match(appPage, /::view-transition-old\(root\)/)
    assert.doesNotMatch(appPage, /requestAutoFitWide/)
    assert.doesNotMatch(appPage, /reportOverflow/)
  })

  it('routes persona requests and scoped NIP07 calls through the app bridge', async () => {
    const appBridge = await readFile(
      new URL('../../src/helpers/window-message/app-bridge.js', import.meta.url),
      'utf8'
    )
    assert.match(appBridge, /case 'WINDOW_NAPP'/)
    assert.match(appBridge, /op === 'getPersonaPublicKeys'/)
    assert.match(appBridge, /PUBKEY_NOT_IN_PERSONA/)
    assert.match(appBridge, /instanceKind === 'widget'/)
    assert.match(appBridge, /session_widgetByKey_\$\{appKey\}_route/)
    assert.match(appBridge, /permissionMeta/)
    assert.match(appBridge, /isWidget: instanceKind === 'widget'/)
    assert.match(appBridge, /case 'AUTO_FIT'/)
    assert.match(appBridge, /onSetMinWidth/)
    assert.doesNotMatch(appBridge, /onAutoFitOverflow/)
  })

  it('registers the widgets layer and Add Widget menu entry', async () => {
    const screen = await readFile(
      new URL('../../src/components/zones/screen/index.js', import.meta.url),
      'utf8'
    )
    const widgets = await readFile(
      new URL('../../src/components/zones/screen/widgets/index.js', import.meta.url),
      'utf8'
    )
    assert.match(screen, /widgets-layer/)
    assert.match(screen, /Add Widget/)
    assert.match(screen, /z-index: 2/)
    assert.match(widgets, /fitWidgets/)
    assert.match(widgets, /WIDGET_MINIMIZED_TTL_MS/)
    assert.match(widgets, /WIDGET_AUTO_FIT_MIN_WIDTH/)
    assert.match(widgets, /shouldApplyVirtualWidth/)
    assert.match(widgets, /onSetMinWidth/)
    assert.match(widgets, /onAutoFitDone/)
    assert.match(screen, /shouldApplyVirtualWidth/)
    assert.match(screen, /onSetMinWidth/)
    assert.match(widgets, /icon-grip-vertical/)
    assert.match(widgets, /icon-pin/)
    assert.match(widgets, /Pin URL/)
    assert.match(widgets, /Remove Widget/)
    assert.match(widgets, /pending-indicator/)
  })

  it('keeps compact loading and the mini ostrich theme', async () => {
    const pending = await readFile(
      new URL('../../src/components/shared/pending-indicator.js', import.meta.url),
      'utf8'
    )
    const loader = await readFile(
      new URL('../../src/assets/html/app-page-loader.txt.html', import.meta.url),
      'utf8'
    )
    assert.match(pending, /pending-indicator-compact/)
    assert.match(loader, /max-width: 240px/)
    assert.match(loader, /#pixel-ostrich/)
    assert.match(loader, /scale\(0\.5\)/)
  })

  it('registers the new storage keys in the schema and permission dialog badges', async () => {
    const schema = await readFile(
      new URL('../../src/constants/storage-schema.js', import.meta.url),
      'utf8'
    )
    const permission = await readFile(
      new URL('../../src/components/zones/permission-dialog/index.js', import.meta.url),
      'utf8'
    )
    assert.match(schema, /local_widgets/)
    assert.match(schema, /local_personas/)
    assert.match(schema, /local_appPersonaSelections/)
    assert.match(permission, /widget-badge/)
    assert.match(permission, /accountUserPk/)
  })
})
