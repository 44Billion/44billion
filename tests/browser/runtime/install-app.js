import { saveSiteManifestToDb } from '#services/idb/browser/queries/site-manifest.js'
import { saveFileChunksToDB } from '#services/idb/browser/queries/file-chunk.js'
import { addressObjToAppId } from '#helpers/app.js'

// Test-only bootstrap. Use the production writers so validation and asset budgets apply.
export async function cacheTestApp ({ manifest, chunks }) {
  const appId = addressObjToAppId({ kind: manifest.kind, pubkey: manifest.pubkey, dTag: manifest.tags.find(tag => tag[0] === 'd')[1] })
  await saveSiteManifestToDb(manifest)
  for (const { root, events } of chunks) {
    await saveFileChunksToDB(manifest, events, appId, { rootHash: root, service: 'blossom' })
  }
  return appId
}
