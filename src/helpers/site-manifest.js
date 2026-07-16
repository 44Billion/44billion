const ROOT_HASH = /^[0-9a-f]{64}$/
const RECOGNIZED_MARKS = new Set(['icon', 'key_art', 'screenshot'])

export function normalizeManifestPath (value) {
  if (typeof value !== 'string') throw new TypeError('Manifest path must be a string')
  const path = value.startsWith('/') ? value.slice(1) : value
  if (!path || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error('Unsafe manifest path')
  }
  const segments = path.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Unsafe manifest path')
  }
  return path
}

function maybePath (value) {
  try {
    return normalizeManifestPath(value)
  } catch (_) {
    return null
  }
}

function parseSize (value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null
  const size = Number(value)
  return Number.isSafeInteger(size) ? size : null
}

function parseReference (tag, service) {
  if (!Array.isArray(tag) || tag[0] !== 'r' || !ROOT_HASH.test(tag[1])) return null
  const descriptor = {
    service,
    root: tag[1],
    paths: [],
    marks: [],
    countries: [],
    mimeType: null,
    size: null,
    tag
  }
  for (const field of tag.slice(2)) {
    if (typeof field !== 'string') continue
    const separator = field.indexOf(' ')
    if (separator <= 0) continue
    const name = field.slice(0, separator)
    const value = field.slice(separator + 1)
    if (name === 'path') {
      const path = maybePath(value)
      if (path && !descriptor.paths.includes(path)) descriptor.paths.push(path)
    } else if (name === 'mark' && RECOGNIZED_MARKS.has(value)) {
      descriptor.marks.push(value)
    } else if (name === 'm' && value) {
      descriptor.mimeType = value
    } else if (name === 'size') {
      descriptor.size = parseSize(value)
    } else if (name === 'country' && value) {
      descriptor.countries.push(value)
    }
  }
  return descriptor
}

/**
 * Normalizes both supported manifest layouts into asset descriptors.
 * IRFS v2 uses r tags for every asset. Blossom keeps routable files in path
 * tags and uses r tags only for media without a route.
 */
export function getManifestAssetDescriptors (manifest) {
  const tags = Array.isArray(manifest?.tags) ? manifest.tags : []
  const advertisedService = tags.find(tag => tag[0] === 'service')?.[1]
  if (advertisedService !== undefined && !['irfs', 'blossom'].includes(advertisedService)) return []
  const service = advertisedService || 'blossom'
  const descriptors = []

  if (service === 'blossom') {
    for (const tag of tags) {
      if (!Array.isArray(tag) || tag[0] !== 'path' || !ROOT_HASH.test(tag[2])) continue
      const path = maybePath(tag[1])
      if (!path) continue
      descriptors.push({
        service,
        root: tag[2],
        paths: [path],
        marks: [],
        countries: [],
        mimeType: null,
        size: null,
        tag
      })
    }
  }

  for (const tag of tags) {
    const descriptor = parseReference(tag, service)
    if (descriptor && (descriptor.paths.length || descriptor.marks.length)) descriptors.push(descriptor)
  }
  return descriptors
}

export function findRouteAssetDescriptor (pathname, manifest) {
  const descriptors = getManifestAssetDescriptors(manifest).filter(asset => asset.paths.length)
  for (const filename of getPotentialFilenameMatches(pathname)) {
    const descriptor = descriptors.find(asset => asset.paths.includes(filename))
    if (descriptor) return { ...descriptor, filename }
  }
  return null
}

export function findMarkedAssetDescriptors (mark, manifest) {
  if (!RECOGNIZED_MARKS.has(mark)) return []
  return getManifestAssetDescriptors(manifest).filter(asset => asset.marks.includes(mark))
}

function * getPotentialFilenameMatches (pathname, htmlOnly = false) {
  let basePath = String(pathname || '')
  if (basePath.startsWith('/')) basePath = basePath.slice(1)
  const endsWithHtml = /\.html?$/.test(basePath)
  if (endsWithHtml || (!htmlOnly && basePath)) yield basePath
  if (!endsWithHtml && basePath.endsWith('/')) basePath = basePath.slice(0, -1)

  let cleanPath = basePath.replace(/(?:\/index)?\.html?$/, '')
  if (cleanPath.endsWith('/')) cleanPath = cleanPath.slice(0, -1)
  if (cleanPath) {
    yield `${cleanPath}.html`
    yield `${cleanPath}.htm`
    yield `${cleanPath}/index.html`
    yield `${cleanPath}/index.htm`
  } else {
    yield 'index.html'
    yield 'index.htm'
  }
  if (basePath !== 'index.html') yield 'index.html'
  if (basePath !== 'index.htm') yield 'index.htm'
}

export function getManifestMetadata (manifest) {
  const tags = Array.isArray(manifest?.tags) ? manifest.tags : []
  const value = name => tags.find(tag => tag[0] === name && typeof tag[1] === 'string' && tag[1].trim())?.[1]?.trim() || null
  return {
    name: value('name'),
    summary: value('summary'),
    descriptions: tags
      .filter(tag => tag[0] === 'description' && typeof tag[1] === 'string' && tag[1].trim())
      .map(tag => ({ text: tag[1].trim(), language: tag[2] || null }))
  }
}

export { ROOT_HASH, RECOGNIZED_MARKS }
