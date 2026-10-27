import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

describe('App Data Access wiring', () => {
  it('mounts the system route and places the first Advanced settings entry', async () => {
    const [router, screen, settings] = await Promise.all([
      readFile(new URL('../../src/components/zones/multi-napp/router.js', import.meta.url), 'utf8'),
      readFile(new URL('../../src/components/zones/screen/index.js', import.meta.url), 'utf8'),
      readFile(new URL('../../src/components/views/settings/index.js', import.meta.url), 'utf8')
    ])
    assert.match(router, /'\/app-data-access'/)
    assert.match(router, /tag: 'app-data-access'/)
    assert.match(screen, /path: '\/app-data-access'/)

    const advanced = settings.indexOf("t('Advanced')")
    const appDataAccess = settings.indexOf("t('App Data Access')")
    const eventStorage = settings.indexOf("storageT('Event storage')")
    assert.ok(advanced >= 0)
    assert.ok(appDataAccess > advanced)
    assert.ok(eventStorage > appDataAccess)
  })

  it('sorts App Updates through the shared app-name comparator', async () => {
    const updates = await readFile(
      new URL('../../src/components/views/napp-updates/index.js', import.meta.url),
      'utf8'
    )
    assert.match(updates, /sortAppIdsByName/)
    assert.match(updates, /getAppName: appId => storage\[`session_appById_\$\{appId\}_name\$`\]\(\)/)
  })
})
