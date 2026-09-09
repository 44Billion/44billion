import { saveFileChunksToDB, deleteStaleFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import { getSiteManifestFromDb, saveSiteManifestToDb } from '#services/idb/browser/queries/site-manifest.js'
import { addressObjToAppId } from '#helpers/app.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToBase16 } from 'libp2r2p/base16'
import { encode } from 'libp2r2p/base93'
import NMMR from 'nmmr'
import { APP_FILE_CHUNK_BYTES } from '#constants/app-file.js'
import { readLocalApps, writeLocalApp, installLock, versionLock } from './state.js'

// Shares the production cache writers with tests; activate only complete builds.
export async function cacheLocalApp ({ manifest, chunks }) {
  const appId = addressObjToAppId({ kind: manifest.kind, pubkey: manifest.pubkey, dTag: manifest.tags.find(tag => tag[0] === 'd')[1] })
  for (const { root, events } of chunks) await saveFileChunksToDB(manifest, events, appId, { rootHash: root, service: 'blossom' })
  await saveSiteManifestToDb(manifest)
  return appId
}

// Local HTTP bytes use the launcher's existing pseudo-Blossom cache representation.
export function localChunks (bytes, root) {
  if (bytesToBase16(sha256(bytes)) !== root) throw new Error('Local asset digest mismatch')
  const total = Math.max(1, Math.ceil(bytes.length / APP_FILE_CHUNK_BYTES))
  return Array.from({ length: total }, (_, index) => ({
    kind: 34601,
    tags: [['d', NMMR.deriveChunkId(root, index)], ['mmr', String(index), String(total), '']],
    content: encode(bytes.slice(index * APP_FILE_CHUNK_BYTES, (index + 1) * APP_FILE_CHUNK_BYTES))
  }))
}

// Call while holding the install lock; live documents retain shared version locks.
export async function pruneLocalVersions (appId) {
  const record = readLocalApps()[appId]
  if (!record) return
  const versions = { ...record.versions }
  for (const version of Object.keys(versions)) {
    if (version === record.version) continue
    await navigator.locks.request(versionLock(appId, version), { ifAvailable: true }, lock => {
      if (lock) delete versions[version]
    })
  }
  await deleteStaleFileChunksFromDb(appId, Object.values(versions).flat())
  writeLocalApp(appId, { ...record, versions })
}

// Fetch all bytes before activation; any failure keeps the previous manifest usable.
export async function installLocalBuild (build, { loadAsset, activate, signal } = {}) {
  return navigator.locks.request(installLock(build.appId), { signal }, async () => {
    const previous = readLocalApps()[build.appId]
    if (previous?.version === build.revision && await getSiteManifestFromDb(build.appId)) return false
    const roots = [...new Set(build.assets.map(asset => asset.root))]
    writeLocalApp(build.appId, previous || { project: build.project, version: null, versions: {} })
    try {
      const chunks = []
      for (const asset of build.assets) {
        signal?.throwIfAborted()
        const bytes = await loadAsset(asset)
        if (bytes.length !== asset.size) throw new Error(`Incomplete local file: ${asset.name}`)
        chunks.push({ root: asset.root, events: localChunks(bytes, asset.root) })
      }
      for (const { root, events } of chunks) {
        await saveFileChunksToDB(build.manifest, events, build.appId, { rootHash: root, service: 'blossom', assetBudget: { mode: 'background' } })
      }
      const previousManifest = await getSiteManifestFromDb(build.appId)
      // Reserve registry space before activation, while no instance can acquire a new lease.
      writeLocalApp(build.appId, { project: build.project, version: build.revision, versions: { ...previous?.versions, [build.revision]: roots } })
      try {
        await activate(build.appId, build.manifest, previousManifest?.meta || {})
      } catch (error) {
        writeLocalApp(build.appId, previous || { project: build.project, version: null, versions: {} })
        if (previousManifest) await activate(build.appId, previousManifest, previousManifest.meta || {})
        throw error
      }
      // Cleanup is retryable maintenance; a completed activation remains successful.
      await pruneLocalVersions(build.appId).catch(error => console.warn('[local app] Cleanup deferred', error))
      return true
    } catch (error) {
      // Retain classification on a failed first installation to prevent remote fallback.
      await pruneLocalVersions(build.appId).catch(() => {})
      throw error
    }
  })
}
