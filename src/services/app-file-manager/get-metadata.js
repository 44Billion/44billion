import { streamFileChunksFromDb, deleteFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import { decode } from 'libp2r2p/base93'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToBase16 } from 'libp2r2p/base16'
import {
  findRouteAssetDescriptor,
  getManifestMetadata,
  getPreferredManifestIconDescriptors
} from '#helpers/site-manifest.js'
import {
  extractHtmlMetadata,
  extractWebManifestIcons,
  resolveAppPath,
  resolveExternalImageUrl
} from '#helpers/html-metadata.js'
import { normalizeAppIconCandidates } from '#helpers/app-icon.js'
import { warnAssetSizeMismatch } from '#helpers/asset-size.js'
import connectivityRetry from '#services/connectivity-retry.js'

const iconDiscoveryByManager = new WeakMap()
const preferredIconByManager = new WeakMap()

// Identifies the manifest version used to reconcile a cached icon.
function getManifestSelectionId (manifest) {
  if (typeof manifest?.id === 'string' && manifest.id) return manifest.id
  const dTag = manifest?.tags?.find(tag => tag[0] === 'd')?.[1] || ''
  return [manifest?.kind, manifest?.pubkey, dTag, manifest?.created_at]
    .map(value => String(value ?? ''))
    .join(':')
}

export async function getIcon (appFileManager, _staleWhileRevalidate = false) {
  const cachedIcon = appFileManager.getCachedMetadata(appFileManager.appId, ['icon'])?.icon
  if (cachedIcon?.url) return cachedIcon
  return getNextIcon(appFileManager, { cachedIcon })
}

// Resolves only the next usable icon candidate after those rejected by the UI.
export async function getNextIcon (appFileManager, { rejected = [], cachedIcon, signal } = {}) {
  cachedIcon ??= appFileManager.getCachedMetadata(appFileManager.appId, ['icon'])?.icon
  const rejectedRoots = new Set(rejected.map(candidate => candidate?.fx).filter(Boolean))
  const rejectedUrls = new Set(rejected.map(candidate => candidate?.url).filter(Boolean))
  const cachedCandidates = normalizeAppIconCandidates(cachedIcon)
  const cached = cachedCandidates.find(candidate =>
    !rejectedUrls.has(candidate.url) && (!candidate.fx || !rejectedRoots.has(candidate.fx))
  )
  if (cached) return cached

  const manifestAssets = getPreferredManifestIconDescriptors(appFileManager.siteManifest)

  const manifestIcon = await resolveNextEntry(
    appFileManager,
    manifestAssets.map(asset => ({ asset })),
    rejectedRoots,
    rejectedUrls,
    cachedIcon,
    signal
  )
  if (manifestIcon) return manifestIcon

  let htmlEntries
  try {
    const discovery = await discoverHtmlIconEntries(appFileManager, signal)
    htmlEntries = discovery.entries
  } catch (error) {
    if (signal?.aborted) throw error
    if (!await connectivityRetry.confirmOnline({ force: true })) {
      error.code = 'OFFLINE'
      throw error
    }
    console.log('Failed to discover icon sources from app HTML:', error)
    return null
  }
  return resolveNextEntry(
    appFileManager,
    htmlEntries,
    rejectedRoots,
    rejectedUrls,
    cachedIcon,
    signal
  )
}

// Resolves the metadata-preferred icon independently from the cached primary choice.
export function getPreferredIcon (appFileManager, {
  manifest = appFileManager.siteManifest,
  cachedIcon,
  signal
} = {}) {
  const manifestId = getManifestSelectionId(manifest)
  let byManifest = preferredIconByManager.get(appFileManager)
  if (!byManifest) {
    byManifest = new Map()
    preferredIconByManager.set(appFileManager, byManifest)
  }
  if (byManifest.has(manifestId)) return byManifest.get(manifestId)

  const request = (async () => {
    cachedIcon ??= appFileManager.getCachedMetadata(appFileManager.appId, ['icon'])?.icon
    const rejectedRoots = new Set()
    const rejectedUrls = new Set()
    const resolutionState = { complete: true }
    const manifestAssets = getPreferredManifestIconDescriptors(manifest)
    let icon = await resolveNextEntry(
      appFileManager,
      manifestAssets.map(asset => ({ asset })),
      rejectedRoots,
      rejectedUrls,
      cachedIcon,
      signal,
      { cacheCandidate: false, resolutionState }
    )
    if (!icon) {
      const discovery = await discoverHtmlIconEntries(appFileManager, signal, manifest)
      if (!discovery.complete) resolutionState.complete = false
      icon = await resolveNextEntry(
        appFileManager,
        discovery.entries,
        rejectedRoots,
        rejectedUrls,
        cachedIcon,
        signal,
        { cacheCandidate: false, resolutionState }
      )
    }
    return { icon, manifestId, selectionComplete: resolutionState.complete }
  })()
  byManifest.set(manifestId, request)
  request.then(
    result => {
      // Share successful work for this manifest, but let a future component
      // retry if no candidate could be resolved during a transient outage.
      if (!result.icon || !result.selectionComplete) byManifest.delete(manifestId)
    },
    () => byManifest.delete(manifestId)
  )
  return request
}

export async function getName (appFileManager, staleWhileRevalidate = false) {
  const manifestName = getManifestMetadata(appFileManager.siteManifest).name
  if (manifestName) {
    appFileManager.cacheMetadata(appFileManager.appId, { name: manifestName })
    return manifestName
  }

  const metadata = appFileManager.getCachedMetadata(appFileManager.appId, ['name', 'description'])
  if (staleWhileRevalidate && (metadata?.name !== undefined || metadata?.description !== undefined)) {
    fetchAndCacheHtmlMetadata(appFileManager)
    return metadata.name
  }
  if (metadata?.name !== undefined) return metadata.name
  return (await fetchAndCacheHtmlMetadata(appFileManager))?.name?.trim() || null
}

export async function getDescription (appFileManager, staleWhileRevalidate = false) {
  const manifestMetadata = getManifestMetadata(appFileManager.siteManifest)
  const manifestDescription = manifestMetadata.descriptions[0]?.text || manifestMetadata.summary
  if (manifestDescription) {
    appFileManager.cacheMetadata(appFileManager.appId, { description: manifestDescription })
    return manifestDescription
  }

  const metadata = appFileManager.getCachedMetadata(appFileManager.appId, ['name', 'description'])
  if (staleWhileRevalidate && (metadata?.description !== undefined || metadata?.name !== undefined)) {
    fetchAndCacheHtmlMetadata(appFileManager)
    return metadata.description
  }
  if (metadata?.description !== undefined) return metadata.description
  return (await fetchAndCacheHtmlMetadata(appFileManager))?.description?.trim() || null
}

async function readAsset (appFileManager, pathname, asset, signal) {
  let cacheStatus = await appFileManager.getFileCacheStatus(pathname, asset, { withMeta: true })
  if (!cacheStatus.isCached) {
    const filename = asset?.filename || asset?.paths?.[0]
    await appFileManager.cacheFile(pathname, asset && {
      ...asset,
      filename: filename || `@metadata:${asset.root}`
    }, null, { signal })
    cacheStatus = await appFileManager.getFileCacheStatus(pathname, asset, { withMeta: true })
  }

  const binaryChunks = []
  let byteLength = 0
  for await (const chunk of streamFileChunksFromDb(appFileManager.appId, cacheStatus.fileRootHash)) {
    const bytes = decode(chunk.evt.content)
    binaryChunks.push(bytes)
    byteLength += bytes.length
  }
  if (!binaryChunks.length) return null
  if (cacheStatus.size !== null && cacheStatus.size !== byteLength) {
    warnAssetSizeMismatch({
      service: cacheStatus.service,
      root: cacheStatus.fileRootHash,
      advertisedSize: cacheStatus.size,
      actualSize: byteLength
    })
  }
  if (cacheStatus.service === 'blossom') {
    const hasher = sha256.create()
    for (const bytes of binaryChunks) hasher.update(bytes)
    if (bytesToBase16(hasher.digest()) !== cacheStatus.fileRootHash) {
      await deleteFileChunksFromDb(appFileManager.appId, cacheStatus.fileRootHash)
      return null
    }
  }
  return { binaryChunks, cacheStatus }
}

function readBlob (blob, method) {
  const reader = new FileReader()
  return new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader[method](blob)
  })
}

async function assetToDataUrl (appFileManager, asset, signal) {
  const result = await readAsset(appFileManager, null, asset, signal)
  if (!result) return null
  const mimeType = asset.mimeType || result.cacheStatus.mimeType || 'application/octet-stream'
  return readBlob(new Blob(result.binaryChunks, { type: mimeType }), 'readAsDataURL')
}

async function assetToText (appFileManager, pathname, asset, signal) {
  const result = await readAsset(appFileManager, pathname, asset, signal)
  if (!result) return null
  return readBlob(
    new Blob(result.binaryChunks, { type: result.cacheStatus.contentType || 'text/plain; charset=utf-8' }),
    'readAsText'
  )
}

function addAssetEntry (entries, seenAssets, asset) {
  if (!asset || seenAssets.has(asset.root)) return
  seenAssets.add(asset.root)
  entries.push({ asset })
}

function addUrlEntry (entries, seenUrls, url) {
  if (!url || seenUrls.has(url)) return
  seenUrls.add(url)
  entries.push({ url })
}

function addHtmlImageSource (entries, seenAssets, seenUrls, manifest, source, htmlMetadata, basePath) {
  const path = resolveAppPath(source.href, basePath, htmlMetadata.baseHref)
  if (path) {
    addAssetEntry(
      entries,
      seenAssets,
      findRouteAssetDescriptor(`/${path}`, manifest)
    )
  }
  addUrlEntry(entries, seenUrls, resolveExternalImageUrl(source.href, htmlMetadata.baseHref))
}

async function addWebManifestIcons (entries, seenAssets, seenUrls, appFileManager, manifest, source, htmlMetadata, basePath, signal, resolutionState) {
  const manifestPath = resolveAppPath(source.href, basePath, htmlMetadata.baseHref)
  const manifestAsset = manifestPath && findRouteAssetDescriptor(`/${manifestPath}`, manifest)
  if (!manifestAsset) return

  try {
    const manifestContent = await assetToText(appFileManager, null, manifestAsset, signal)
    if (manifestContent === null) {
      resolutionState.complete = false
      return
    }
    for (const icon of extractWebManifestIcons(manifestContent)) {
      const iconPath = resolveAppPath(icon.href, manifestAsset.filename || manifestPath)
      if (iconPath) {
        addAssetEntry(
          entries,
          seenAssets,
          findRouteAssetDescriptor(`/${iconPath}`, manifest)
        )
      }
      addUrlEntry(entries, seenUrls, resolveExternalImageUrl(icon.href))
    }
  } catch (error) {
    if (signal?.aborted) throw error
    if (!await connectivityRetry.confirmOnline({ force: true })) throw error
    resolutionState.complete = false
    console.log('Failed to read web app manifest icons:', error)
  }
}

async function fetchRootHtmlMetadata (appFileManager, signal, manifest = appFileManager.siteManifest, resolutionState) {
  const indexAsset = findRouteAssetDescriptor('/', manifest)
  if (!indexAsset) return { metadata: extractHtmlMetadata(''), basePath: 'index.html' }
  const htmlContent = await assetToText(appFileManager, '/', indexAsset, signal)
  if (htmlContent === null && resolutionState) resolutionState.complete = false
  return {
    metadata: extractHtmlMetadata(htmlContent || ''),
    basePath: indexAsset.filename || 'index.html'
  }
}

async function discoverHtmlIconEntries (appFileManager, signal, manifest = appFileManager.siteManifest) {
  const manifestKey = getManifestSelectionId(manifest)
  let byManifest = iconDiscoveryByManager.get(appFileManager)
  if (!byManifest) {
    byManifest = new Map()
    iconDiscoveryByManager.set(appFileManager, byManifest)
  }
  if (byManifest.has(manifestKey)) return byManifest.get(manifestKey)

  const entries = []
  const seenAssets = new Set()
  const seenUrls = new Set()
  const resolutionState = { complete: true }
  const { metadata: htmlMetadata, basePath } = await fetchRootHtmlMetadata(
    appFileManager,
    signal,
    manifest,
    resolutionState
  )
  const browserSources = htmlMetadata.iconSources.filter(source =>
    ['icon', 'apple-touch-icon', 'mask-icon'].includes(source.kind)
  )
  const manifestSources = htmlMetadata.iconSources.filter(source => source.kind === 'manifest')
  const socialSources = htmlMetadata.iconSources.filter(source =>
    ['tile-image', 'social-image'].includes(source.kind)
  )

  for (const source of browserSources) {
    addHtmlImageSource(entries, seenAssets, seenUrls, manifest, source, htmlMetadata, basePath)
  }
  for (const source of manifestSources) {
    await addWebManifestIcons(
      entries,
      seenAssets,
      seenUrls,
      appFileManager,
      manifest,
      source,
      htmlMetadata,
      basePath,
      signal,
      resolutionState
    )
  }
  for (const source of socialSources) {
    addHtmlImageSource(entries, seenAssets, seenUrls, manifest, source, htmlMetadata, basePath)
  }

  const discovery = { entries, complete: resolutionState.complete }
  // An incomplete discovery may have skipped a temporarily unavailable HTML
  // or web-manifest asset, so only definitive results are reusable.
  if (discovery.complete) byManifest.set(manifestKey, discovery)
  return discovery
}

async function resolveNextEntry (
  appFileManager,
  entries,
  rejectedRoots,
  rejectedUrls,
  cachedIcon,
  signal,
  { cacheCandidate = true, resolutionState } = {}
) {
  const cachedCandidates = normalizeAppIconCandidates(cachedIcon)
  for (const entry of entries) {
    if (entry.url) {
      if (rejectedUrls.has(entry.url)) continue
      if (cacheCandidate) cacheIconCandidate(appFileManager, { fx: null, url: entry.url }, cachedIcon)
      return { fx: null, url: entry.url }
    }
    if (rejectedRoots.has(entry.asset.root)) continue
    const cached = cachedCandidates.find(candidate =>
      candidate.fx === entry.asset.root && !rejectedUrls.has(candidate.url)
    )
    if (cached) return cached
    try {
      const url = await assetToDataUrl(appFileManager, entry.asset, signal)
      if (!url) {
        if (resolutionState) resolutionState.complete = false
        continue
      }
      if (rejectedUrls.has(url)) continue
      const icon = { fx: entry.asset.root, url }
      if (cacheCandidate) cacheIconCandidate(appFileManager, icon, cachedIcon)
      return icon
    } catch (error) {
      if (signal?.aborted) throw error
      if (!await connectivityRetry.confirmOnline({ force: true })) {
        error.code = 'OFFLINE'
        throw error
      }
      if (resolutionState) resolutionState.complete = false
      console.log(`Failed to resolve icon asset ${entry.asset.root}:`, error)
    }
  }
  return null
}

function cacheIconCandidate (appFileManager, candidate, cachedIcon) {
  const candidates = normalizeAppIconCandidates(cachedIcon)
  if (!candidates.some(icon => icon.url === candidate.url)) candidates.push(candidate)
  const icon = { ...candidates[0], candidates }
  appFileManager.cacheMetadata(appFileManager.appId, { icon })
}

async function fetchAndCacheHtmlMetadata (appFileManager) {
  try {
    const { metadata } = await fetchRootHtmlMetadata(appFileManager)
    const toCache = {}
    if (metadata.name !== undefined) toCache.name = metadata.name
    if (metadata.description !== undefined) toCache.description = metadata.description
    if (Object.keys(toCache).length) appFileManager.cacheMetadata(appFileManager.appId, toCache)
    return metadata
  } catch (error) {
    console.log('Failed to fetch HTML metadata:', error)
    return { name: undefined, description: undefined }
  }
}

export function extractMetadataFromHtml (htmlContent) {
  const { name, description } = extractHtmlMetadata(htmlContent)
  return { name, description }
}
