import { cacheLocalApp } from '#services/local-dev/install.js'
import { writeLocalApp } from '#services/local-dev/state.js'

export async function cacheTestApp ({ manifest, chunks }) {
  const appId = await cacheLocalApp({ manifest, chunks })
  // Production local builds are classified separately from public Blossom downloads.
  writeLocalApp(appId, {
    project: 'browser-test',
    version: manifest.id,
    versions: { [manifest.id]: chunks.map(({ root }) => root) }
  })
  return appId
}
