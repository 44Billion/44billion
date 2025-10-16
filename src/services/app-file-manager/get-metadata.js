import { streamFileChunksFromDb } from '#services/idb/browser/queries/file-chunk.js'
import { decode } from '#services/base93-decoder.js'

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

async function fetchAndCacheIcon (appFileManager, cachedIcon = null) {
  // Get current favicon metadata
  const favicon = appFileManager.getFaviconMetadata()
  if (!favicon) return null

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
    // Extract title from <title> tag
    // This regex handles various spacing, attribute orders, and quote styles
    const titleRegex = /<title[^>]*>([\s\S]*?)<\/title>/i
    const titleMatch = htmlContent.match(titleRegex)
    if (titleMatch && titleMatch[1]) {
      name = titleMatch[1].trim()
    }

    // Extract description from <meta name="description"> tag
    // This regex handles:
    // - Single or double quotes
    // - Extra spaces between attributes
    // - Different attribute orders
    // - Self-closing tags
    const metaDescRegex = /<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i
    const metaDescMatch = htmlContent.match(metaDescRegex)
    if (metaDescMatch && metaDescMatch[1]) {
      description = metaDescMatch[1].trim()
    }

    // Try alternative pattern if the first one didn't match (content before name)
    if (!description) {
      const altMetaDescRegex = /<meta\s+[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']description["'][^>]*>/i
      const altMetaDescMatch = htmlContent.match(altMetaDescRegex)
      if (altMetaDescMatch && altMetaDescMatch[1]) {
        description = altMetaDescMatch[1].trim()
      }
    }
  } catch (error) {
    console.log('Error parsing HTML metadata:', error)
  }

  return { name, description }
}
