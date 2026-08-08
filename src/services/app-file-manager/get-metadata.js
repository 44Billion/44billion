import { streamFileChunksFromDb, deleteFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import { decode } from 'libp2r2p/base93'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToBase16 } from 'libp2r2p/base16'
import {
  findFaviconAssetDescriptors,
  findMarkedAssetDescriptors,
  findRouteAssetDescriptor,
  getManifestMetadata
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

  const seenRoots = new Set()
  const manifestAssets = []
  for (const asset of findMarkedAssetDescriptors('icon', appFileManager.siteManifest)) {
    if (!seenRoots.has(asset.root)) {
      seenRoots.add(asset.root)
      manifestAssets.push(asset)
    }
  }
  for (const favicon of findFaviconAssetDescriptors(appFileManager.siteManifest)) {
    if (!seenRoots.has(favicon.root)) {
      seenRoots.add(favicon.root)
      manifestAssets.push(favicon)
    }
  }

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
    htmlEntries = await discoverHtmlIconEntries(appFileManager, signal)
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

function addHtmlImageSource (entries, seenAssets, seenUrls, appFileManager, source, htmlMetadata, basePath) {
  const path = resolveAppPath(source.href, basePath, htmlMetadata.baseHref)
  if (path) {
    addAssetEntry(
      entries,
      seenAssets,
      findRouteAssetDescriptor(`/${path}`, appFileManager.siteManifest)
    )
  }
  addUrlEntry(entries, seenUrls, resolveExternalImageUrl(source.href, htmlMetadata.baseHref))
}

async function addWebManifestIcons (entries, seenAssets, seenUrls, appFileManager, source, htmlMetadata, basePath, signal) {
  const manifestPath = resolveAppPath(source.href, basePath, htmlMetadata.baseHref)
  const manifestAsset = manifestPath && findRouteAssetDescriptor(`/${manifestPath}`, appFileManager.siteManifest)
  if (!manifestAsset) return

  try {
    const manifestContent = await assetToText(appFileManager, null, manifestAsset, signal)
    for (const icon of extractWebManifestIcons(manifestContent)) {
      const iconPath = resolveAppPath(icon.href, manifestAsset.filename || manifestPath)
      if (iconPath) {
        addAssetEntry(
          entries,
          seenAssets,
          findRouteAssetDescriptor(`/${iconPath}`, appFileManager.siteManifest)
        )
      }
      addUrlEntry(entries, seenUrls, resolveExternalImageUrl(icon.href))
    }
  } catch (error) {
    if (signal?.aborted) throw error
    if (!await connectivityRetry.confirmOnline({ force: true })) throw error
    console.log('Failed to read web app manifest icons:', error)
  }
}

async function fetchRootHtmlMetadata (appFileManager, signal) {
  const indexAsset = findRouteAssetDescriptor('/', appFileManager.siteManifest)
  if (!indexAsset) return { metadata: extractHtmlMetadata(''), basePath: 'index.html' }
  const htmlContent = await assetToText(appFileManager, '/', indexAsset, signal)
  return {
    metadata: extractHtmlMetadata(htmlContent || ''),
    basePath: indexAsset.filename || 'index.html'
  }
}

async function discoverHtmlIconEntries (appFileManager, signal) {
  const manifestKey = appFileManager.siteManifest?.id || appFileManager.siteManifest?.created_at || appFileManager.siteManifest
  const cached = iconDiscoveryByManager.get(appFileManager)
  if (cached?.manifestKey === manifestKey) return cached.entries

  const entries = []
  const seenAssets = new Set()
  const seenUrls = new Set()
  const { metadata: htmlMetadata, basePath } = await fetchRootHtmlMetadata(appFileManager, signal)
  const browserSources = htmlMetadata.iconSources.filter(source =>
    ['icon', 'apple-touch-icon', 'mask-icon'].includes(source.kind)
  )
  const manifestSources = htmlMetadata.iconSources.filter(source => source.kind === 'manifest')
  const socialSources = htmlMetadata.iconSources.filter(source =>
    ['tile-image', 'social-image'].includes(source.kind)
  )

  for (const source of browserSources) {
    addHtmlImageSource(entries, seenAssets, seenUrls, appFileManager, source, htmlMetadata, basePath)
  }
  for (const source of manifestSources) {
    await addWebManifestIcons(entries, seenAssets, seenUrls, appFileManager, source, htmlMetadata, basePath, signal)
  }
  for (const source of socialSources) {
    addHtmlImageSource(entries, seenAssets, seenUrls, appFileManager, source, htmlMetadata, basePath)
  }

  iconDiscoveryByManager.set(appFileManager, { manifestKey, entries })
  return entries
}

async function resolveNextEntry (appFileManager, entries, rejectedRoots, rejectedUrls, cachedIcon, signal) {
  for (const entry of entries) {
    if (entry.url) {
      if (rejectedUrls.has(entry.url)) continue
      cacheIconCandidate(appFileManager, { fx: null, url: entry.url }, cachedIcon)
      return { fx: null, url: entry.url }
    }
    if (rejectedRoots.has(entry.asset.root)) continue
    try {
      const url = await assetToDataUrl(appFileManager, entry.asset, signal)
      if (!url || rejectedUrls.has(url)) continue
      const icon = { fx: entry.asset.root, url }
      cacheIconCandidate(appFileManager, icon, cachedIcon)
      return icon
    } catch (error) {
      if (signal?.aborted) throw error
      if (!await connectivityRetry.confirmOnline({ force: true })) {
        error.code = 'OFFLINE'
        throw error
      }
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
