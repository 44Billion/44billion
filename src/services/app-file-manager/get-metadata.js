import { streamFileChunksFromDb, deleteFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import { decode } from 'libp2r2p/base93'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToBase16 } from 'libp2r2p/base16'
import { findMarkedAssetDescriptors, getManifestMetadata } from '#helpers/site-manifest.js'
import { warnAssetSizeMismatch } from '#helpers/asset-size.js'

export async function getIcon (appFileManager, staleWhileRevalidate = false) {
  const cachedIcon = appFileManager.getCachedMetadata(appFileManager.appId, ['icon'])?.icon
  if (staleWhileRevalidate && cachedIcon) {
    fetchAndCacheIcon(appFileManager, cachedIcon)
    return cachedIcon
  }
  if (cachedIcon) return cachedIcon
  return fetchAndCacheIcon(appFileManager)
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

async function fetchAndCacheIcon (appFileManager, cachedIcon = null) {
  const marked = findMarkedAssetDescriptors('icon', appFileManager.siteManifest)[0]
  const asset = marked || appFileManager.getFaviconMetadata()?.tag
  if (!asset) return null
  if (cachedIcon?.fx === asset.root) return cachedIcon

  try {
    let cacheStatus = await appFileManager.getFileCacheStatus(null, asset, { withMeta: true })
    if (!cacheStatus.isCached) {
      await appFileManager.cacheFile(null, { ...asset, filename: asset.paths[0] || `@icon:${asset.root}` })
      cacheStatus = await appFileManager.getFileCacheStatus(null, asset, { withMeta: true })
    }

    const binaryChunks = []
    let byteLength = 0
    for await (const chunk of streamFileChunksFromDb(appFileManager.appId, asset.root)) {
      const bytes = decode(chunk.evt.content)
      binaryChunks.push(bytes)
      byteLength += bytes.length
    }
    if (!binaryChunks.length) return null
    if (asset.size !== null && asset.size !== byteLength) {
      warnAssetSizeMismatch({
        service: asset.service,
        root: asset.root,
        advertisedSize: asset.size,
        actualSize: byteLength
      })
    }
    if (asset.service === 'blossom') {
      const hasher = sha256.create()
      for (const bytes of binaryChunks) hasher.update(bytes)
      if (bytesToBase16(hasher.digest()) !== asset.root) {
        await deleteFileChunksFromDb(appFileManager.appId, asset.root)
        return null
      }
    }

    const mimeType = asset.mimeType || cacheStatus.mimeType || 'application/octet-stream'
    const blob = new Blob(binaryChunks, { type: mimeType })
    const reader = new FileReader()
    const dataUrl = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
    const icon = { fx: asset.root, url: dataUrl }
    appFileManager.cacheMetadata(appFileManager.appId, { icon })
    return icon
  } catch (error) {
    console.log('Failed to fetch icon:', error)
    return null
  }
}

async function fetchAndCacheHtmlMetadata (appFileManager) {
  try {
    let cacheStatus = await appFileManager.getFileCacheStatus('/', null, { withMeta: true })
    if (!cacheStatus.isCached) {
      await appFileManager.cacheFile('/', null)
      cacheStatus = await appFileManager.getFileCacheStatus('/', null, { withMeta: true })
    }

    const binaryChunks = []
    let byteLength = 0
    for await (const chunk of streamFileChunksFromDb(appFileManager.appId, cacheStatus.fileRootHash)) {
      const bytes = decode(chunk.evt.content)
      binaryChunks.push(bytes)
      byteLength += bytes.length
    }
    if (!binaryChunks.length) return { name: undefined, description: undefined }
    if (cacheStatus.size !== null && cacheStatus.size !== byteLength) {
      warnAssetSizeMismatch({
        service: cacheStatus.service,
        root: cacheStatus.fileRootHash,
        advertisedSize: cacheStatus.size,
        actualSize: byteLength
      })
    }

    const reader = new FileReader()
    const htmlContent = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsText(new Blob(binaryChunks, { type: cacheStatus.contentType }))
    })
    const metadata = extractMetadataFromHtml(htmlContent)
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
  let name
  let description
  try {
    name = htmlContent.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()
    if (!name) {
      name = htmlContent.match(/<meta\s+[^>]*(?:property|name)\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i)?.[1]?.trim() ||
        htmlContent.match(/<meta\s+[^>]*content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["']og:title["'][^>]*>/i)?.[1]?.trim()
    }
    description = htmlContent.match(/<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i)?.[1]?.trim() ||
      htmlContent.match(/<meta\s+[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']description["'][^>]*>/i)?.[1]?.trim() ||
      htmlContent.match(/<meta\s+[^>]*(?:property|name)\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i)?.[1]?.trim() ||
      htmlContent.match(/<meta\s+[^>]*content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["']og:description["'][^>]*>/i)?.[1]?.trim()
  } catch (error) {
    console.log('Error parsing HTML metadata:', error)
  }
  return { name, description }
}
