import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFile } from 'node:fs/promises'

describe('app bridge routing marker', () => {
  it('wires the marker end-to-end and keeps the app URL clean', async () => {
    const appBridge = await readFile(
      new URL('../../src/helpers/window-message/app-bridge.js', import.meta.url),
      'utf8'
    )
    const appPage = await readFile(
      new URL('../../src/scripts/app-page.txt.js', import.meta.url),
      'utf8'
    )
    const sw = await readFile(
      new URL('../../src/service-workers/app/index.js', import.meta.url),
      'utf8'
    )
    const host = await readFile(
      new URL('../../src/components/zones/app-bridge-host.js', import.meta.url),
      'utf8'
    )

    // Launcher appends the marker to the app iframe URL.
    assert.match(appBridge, /withBridgeMarker/)
    assert.match(appBridge, /~~bridgeId=/)

    // Injected script strips it before the app's own code runs.
    assert.match(appPage, /stripBridgeMarker/)
    assert.match(appPage, /searchParams\.delete\('~~bridgeId'\)/)

    // SW remembers the bridge id early and routes strictly to the same tab.
    assert.match(sw, /searchParams\.get\('~~bridgeId'\)/)
    assert.match(sw, /appPageBridgeIds\.set/)
    assert.match(sw, /hasTrustedClientForBridge/)
    assert.match(sw, /findReadyBridgeClient\(clients, readyClients, bridgeId, \{ strict \}\)/)

    // Dialog falls back to the stored app name instead of only "App Download".
    assert.match(host, /session_appById_\$\{state\.appId\}_name/)
  })
})
