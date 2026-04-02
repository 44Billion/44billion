import { streamFileChunksFromDb, deleteFileChunksFromDb, countFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import { decode } from '#services/base93-decoder.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToBase16 } from '#helpers/base16.js'
import { getSiteManifest, getUserRelays } from '#helpers/nostr-queries.js'
import { nappRelays } from '#services/nostr-relays.js'
import AppFileDownloader from '#services/app-file-downloader/index.js'

export async function getIcon (appFileManager, staleWhileRevalidate = false) {
  const metadata = appFileManager.getCachedMetadata(appFileManager.appId, ['icon'])
  const cachedIcon = metadata?.icon

  // If staleWhileRevalidate is true and we have a cached icon, start revalidation in background
  if (staleWhileRevalidate && cachedIcon) {
    // Don't await this, let it run in background
    fetchAndCacheIcon(appFileManager, cachedIcon)
    return cachedIcon
  }

  // Return cached icon if available (and we're not doing stale-while-revalidate)
  if (cachedIcon) return cachedIcon

  // Fetch and cache icon
  return await fetchAndCacheIcon(appFileManager)
}

export async function getName (appFileManager, staleWhileRevalidate = false) {
  const metadata = appFileManager.getCachedMetadata(appFileManager.appId, ['name', 'description'])
  const cachedName = metadata?.name

  // If staleWhileRevalidate is true and we have cached metadata, start revalidation in background
  if (staleWhileRevalidate && (cachedName !== undefined || metadata?.description !== undefined)) {
    // Don't await this, let it run in background
    fetchAndCacheHtmlMetadata(appFileManager)
    return cachedName
  }

  // Return cached name if available (and we're not doing stale-while-revalidate)
  if (cachedName !== undefined) return cachedName

  // Fetch and cache metadata
  const result = await fetchAndCacheHtmlMetadata(appFileManager)
  return result?.name?.trim() || null
}

export async function getDescription (appFileManager, staleWhileRevalidate = false) {
  const metadata = appFileManager.getCachedMetadata(appFileManager.appId, ['name', 'description'])
  const cachedDescription = metadata?.description

  // If staleWhileRevalidate is true and we have cached metadata, start revalidation in background
  if (staleWhileRevalidate && (cachedDescription !== undefined || metadata?.name !== undefined)) {
    // Don't await this, let it run in background
    fetchAndCacheHtmlMetadata(appFileManager)
    return cachedDescription
  }

  // Return cached description if available (and we're not doing stale-while-revalidate)
  if (cachedDescription !== undefined) return cachedDescription

  // Fetch and cache metadata
  const result = await fetchAndCacheHtmlMetadata(appFileManager)
  return result?.description?.trim() || null
}

const MANIFEST_TO_LISTING_KIND = { 35128: 37348, 35129: 37349, 35130: 37350 }

async function fetchAndCacheIcon (appFileManager, cachedIcon = null) {
  // Get current favicon metadata
  const favicon = appFileManager.getFaviconMetadata()
  if (!favicon) return fetchAndCacheIconFromListing(appFileManager, cachedIcon)

  // If we have a cached icon and the hash hasn't changed, return the cached one
  if (cachedIcon && cachedIcon.fx === favicon.rootHash) {
    return cachedIcon
  }

  try {
    // Check if favicon file is cached
    let cacheStatus = await appFileManager.getFileCacheStatus(null, favicon.tag, { withMeta: true })
    if (!cacheStatus.isCached) {
      // Cache the file if not already cached
      await appFileManager.cacheFile(null, favicon.tag)
      cacheStatus = await appFileManager.getFileCacheStatus(null, favicon.tag, { withMeta: true })
    }

    // Get all chunks for the favicon
    const allChunks = []
    for await (const chunk of streamFileChunksFromDb(appFileManager.appId, favicon.rootHash)) {
      allChunks.push(chunk.evt.content)
    }
    if (allChunks.length === 0) return null

    // Process chunks to create data URL
    const binaryChunks = allChunks.map(chunk => decode(chunk))

    if (appFileManager.service === 'blossom') {
      const hasher = sha256.create()
      for (const bytes of binaryChunks) hasher.update(bytes)
      if (bytesToBase16(hasher.digest()) !== favicon.rootHash) {
        if (favicon.rootHash) await deleteFileChunksFromDb(appFileManager.appId, favicon.rootHash)
        return null
      }
    }

    const blob = new Blob(binaryChunks, { type: favicon.contentType })

    const reader = new FileReader()
    const dataUrlPromise = new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })

    const dataUrl = await dataUrlPromise

    // Create icon object
    const icon = {
      fx: favicon.rootHash,
      url: dataUrl
    }

    // Cache the icon metadata
    appFileManager.cacheMetadata(appFileManager.appId, { icon })

    return icon
  } catch (error) {
    console.log('Failed to fetch icon:', error)
    return null
  }
}

async function fetchAndCacheIconFromListing (appFileManager, cachedIcon = null) {
  const listingKind = MANIFEST_TO_LISTING_KIND[appFileManager.addressObj.kind]
  if (!listingKind) return null

  const { pubkey, dTag } = appFileManager.addressObj

  let listingEvent
  try {
    listingEvent = await getSiteManifest({ kind: listingKind, pubkey, dTag })
  } catch (err) {
    console.log('Failed to fetch app listing event for icon:', err)
    return null
  }
  if (!listingEvent) return null

  const iconTag = listingEvent.tags.find(t => t[0] === 'icon')
  if (!iconTag?.[1]) return null

  const iconHash = iconTag[1]
  const mimeType = iconTag[2] || null

  if (cachedIcon?.fx === iconHash) return cachedIcon

  const listingService = listingEvent.tags.find(t => t[0] === 'service')?.[1] || 'blossom'

  const relaysInfo = await getUserRelays([pubkey])
  const writeRelays = Array.from(relaysInfo[pubkey]?.write || [])
  if (writeRelays.length === 0) writeRelays.push(...nappRelays)

  const chunkStatus = await countFileChunksFromDb(appFileManager.appId, iconHash)
  if (!chunkStatus.total || chunkStatus.count < chunkStatus.total) {
    const downloader = new AppFileDownloader(appFileManager.appId, iconHash, writeRelays, { service: listingService, mimeType })
    for await (const report of downloader.run()) {
      if (report.error) {
        console.log('Failed to download app listing icon:', report.error)
        return null
      }
    }
  }

  const allChunks = []
  for await (const chunk of streamFileChunksFromDb(appFileManager.appId, iconHash)) {
    allChunks.push(chunk.evt.content)
  }
  if (allChunks.length === 0) return null

  const binaryChunks = allChunks.map(chunk => decode(chunk))

  if (listingService === 'blossom') {
    const hasher = sha256.create()
    for (const bytes of binaryChunks) hasher.update(bytes)
    if (bytesToBase16(hasher.digest()) !== iconHash) {
      await deleteFileChunksFromDb(appFileManager.appId, iconHash)
      return null
    }
  }

  const contentType = mimeType
    ? (/^(?:text\/|application\/json)[^;]*$/.test(mimeType) ? `${mimeType}; charset=utf-8` : mimeType)
    : 'application/octet-stream'
  const blob = new Blob(binaryChunks, { type: contentType })
  const reader = new FileReader()
  const dataUrl = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })

  const icon = { fx: iconHash, url: dataUrl }
  appFileManager.cacheMetadata(appFileManager.appId, { icon })
  return icon
}

async function fetchAndCacheHtmlMetadata (appFileManager) {
  try {
    // Get the index file status
    const cacheStatus = await appFileManager.getFileCacheStatus('/', null, { withMeta: true })
    if (!cacheStatus.isCached) {
      // Cache the file if not already cached
      await appFileManager.cacheFile('/', null)
    }

    // Get all chunks for the index file
    const allChunks = []
    for await (const chunk of streamFileChunksFromDb(appFileManager.appId, cacheStatus.fileRootHash)) {
      allChunks.push(chunk.evt.content)
    }
    if (allChunks.length === 0) return { name: undefined, description: undefined }

    // Process chunks to create HTML content
    const binaryChunks = allChunks.map(chunk => decode(chunk))
    const blob = new Blob(binaryChunks, { type: cacheStatus.contentType })

    const reader = new FileReader()
    const htmlPromise = new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsText(blob)
    })

    const htmlContent = await htmlPromise

    // Extract name and description from HTML
    const { name, description } = extractMetadataFromHtml(htmlContent)

    // Cache the metadata if we have values
    const metadataToCache = {}
    if (name !== undefined) metadataToCache.name = name
    if (description !== undefined) metadataToCache.description = description

    if (Object.keys(metadataToCache).length > 0) {
      appFileManager.cacheMetadata(appFileManager.appId, metadataToCache)
    }

    return { name, description }
  } catch (error) {
    console.log('Failed to fetch HTML metadata:', error)
    return { name: undefined, description: undefined }
  }
}

function extractMetadataFromHtml (htmlContent) {
  let name
  let description

  try {
    const titleRegex = /<title[^>]*>([\s\S]*?)<\/title>/i
    const titleMatch = htmlContent.match(titleRegex)
    if (titleMatch && titleMatch[1]) {
      name = titleMatch[1].trim()
    }

    if (!name) {
      const ogTitleRegex = /<meta\s+[^>]*(?:property|name)\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i
      const ogTitleMatch = htmlContent.match(ogTitleRegex)
      if (ogTitleMatch && ogTitleMatch[1]) {
        name = ogTitleMatch[1].trim()
      } else {
        const altOgTitleRegex = /<meta\s+[^>]*content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["']og:title["'][^>]*>/i
        const altOgTitleMatch = htmlContent.match(altOgTitleRegex)
        if (altOgTitleMatch && altOgTitleMatch[1]) {
          name = altOgTitleMatch[1].trim()
        }
      }
    }

    const metaDescRegex = /<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i
    const metaDescMatch = htmlContent.match(metaDescRegex)
    if (metaDescMatch && metaDescMatch[1]) {
      description = metaDescMatch[1].trim()
    }

    if (!description) {
      const altMetaDescRegex = /<meta\s+[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']description["'][^>]*>/i
      const altMetaDescMatch = htmlContent.match(altMetaDescRegex)
      if (altMetaDescMatch && altMetaDescMatch[1]) {
        description = altMetaDescMatch[1].trim()
      }
    }

    if (!description) {
      const ogDescRegex = /<meta\s+[^>]*(?:property|name)\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i
      const ogDescMatch = htmlContent.match(ogDescRegex)
      if (ogDescMatch && ogDescMatch[1]) {
        description = ogDescMatch[1].trim()
      } else {
        const altOgDescRegex = /<meta\s+[^>]*content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["']og:description["'][^>]*>/i
        const altOgDescMatch = htmlContent.match(altOgDescRegex)
        if (altOgDescMatch && altOgDescMatch[1]) {
          description = altOgDescMatch[1].trim()
        }
      }
    }
  } catch (error) {
    console.log('Error parsing HTML metadata:', error)
  }

  return { name, description }
}
