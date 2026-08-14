import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToBase16 } from 'libp2r2p/base16'
import {
  isValidPublicBlossomServerUrl,
  isValidPublicRelayUrl,
  normalizeBlossomServerUrl,
  normalizeRelayUrl
} from 'libp2r2p/url'

const ROOT_HASH = /^[0-9a-f]{64}$/
const RECOGNIZED_MARKS = new Set(['icon', 'key_art', 'screenshot'])
const FAVICON_BASENAME = /^(?:favicon(?:[-_.]\w+)*|apple-touch-icon(?:-precomposed|[-_.]\w+)*)\.(?:ico|svg|webp|png|jpe?g|gif|avif)$/i
const MAX_SOURCE_HINTS_PER_TYPE = 20

export function normalizeManifestPath (value) {
  if (typeof value !== 'string') throw new TypeError('Manifest path must be a string')
  const path = value.startsWith('/') ? value.slice(1) : value
  // eslint-disable-next-line no-control-regex
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

function getManifestAggregateLines (manifest) {
  const tags = Array.isArray(manifest?.tags) ? manifest.tags : []
  const advertisedService = tags.find(tag => Array.isArray(tag) && tag[0] === 'service')?.[1]
  if (advertisedService !== undefined && !['irfs', 'blossom'].includes(advertisedService)) return []
  const lines = []

  if (advertisedService === 'irfs') {
    for (const tag of tags) {
      if (!Array.isArray(tag) || tag[0] !== 'r' || !ROOT_HASH.test(tag[1])) continue
      for (const field of tag.slice(2)) {
        if (typeof field !== 'string' || !field.startsWith('path ')) continue
        const path = maybePath(field.slice(5))
        if (path) lines.push(`${tag[1]} /${path}\n`)
      }
    }
  } else {
    for (const tag of tags) {
      if (!Array.isArray(tag) || tag[0] !== 'path' || !ROOT_HASH.test(tag[2])) continue
      const path = maybePath(tag[1])
      if (path) lines.push(`${tag[2]} /${path}\n`)
    }
  }

  return lines
}

export function getManifestAggregateHash (manifest) {
  const lines = getManifestAggregateLines(manifest)
  if (!lines.length) return null
  return bytesToBase16(sha256(new TextEncoder().encode(lines.sort().join(''))))
}

export function getManifestPublishedAt (manifest, {
  now = Math.floor(Date.now() / 1000),
  futureSkewSeconds = 600
} = {}) {
  const value = manifest?.tags?.find(tag => Array.isArray(tag) && tag[0] === 'published_at')?.[1]
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp > now + futureSkewSeconds) return null
  return timestamp
}

export function formatManifestVersion (manifest, options) {
  const aggregateHash = getManifestAggregateHash(manifest)
  if (!aggregateHash) return null
  const shortHash = aggregateHash.slice(0, 8)
  const publishedAt = getManifestPublishedAt(manifest, options)
  if (publishedAt === null) return shortHash
  const date = new Date(publishedAt * 1000).toISOString().split('T')[0]
  return `${date}-${shortHash}`
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

export function findFaviconAssetDescriptor (manifest) {
  return findFaviconAssetDescriptors(manifest)[0] || null
}

export function findFaviconAssetDescriptors (manifest) {
  const favicons = []
  for (const descriptor of getManifestAssetDescriptors(manifest)) {
    const filename = descriptor.paths.find(path => FAVICON_BASENAME.test(path.split('/').pop()))
    if (filename) favicons.push({ ...descriptor, filename })
  }
  return favicons
}

function iconPathQuality (path) {
  const filename = path.split('/').pop()
  if (/\.svg$/i.test(filename)) return 1000000
  const dimensions = [...filename.matchAll(/(?:^|[-_.])(\d{2,5})x(\d{2,5})(?=[-_.]|$)/gi)]
    .map(match => Math.min(Number(match[1]), Number(match[2])))
  if (dimensions.length) return Math.max(...dimensions)
  if (/^apple-touch-icon/i.test(filename)) return 180
  if (/\.ico$/i.test(filename)) return 32
  return 1
}

// Keeps explicit publisher ordering, except when nappup marked an automatic icon.
export function getPreferredManifestIconDescriptors (manifest) {
  const descriptors = getManifestAssetDescriptors(manifest)
  const pathsByRoot = new Map()
  for (const descriptor of descriptors) {
    const paths = pathsByRoot.get(descriptor.root) || []
    for (const path of descriptor.paths) {
      if (!paths.includes(path)) paths.push(path)
    }
    pathsByRoot.set(descriptor.root, paths)
  }
  const entries = []
  const seenRoots = new Set()
  const add = descriptor => {
    if (!descriptor || seenRoots.has(descriptor.root)) return
    seenRoots.add(descriptor.root)
    entries.push({
      ...descriptor,
      paths: [...new Set([...descriptor.paths, ...(pathsByRoot.get(descriptor.root) || [])])]
    })
  }
  for (const descriptor of descriptors.filter(asset => asset.marks.includes('icon'))) add(descriptor)
  for (const descriptor of descriptors) {
    if (descriptor.paths.some(path => FAVICON_BASENAME.test(path.split('/').pop()))) add(descriptor)
  }
  const isAutoIcon = manifest?.tags?.some(tag =>
    Array.isArray(tag) && tag[0] === 'auto' && tag[1] === 'icon'
  )
  if (!isAutoIcon) return entries
  return entries
    .map((descriptor, index) => ({
      descriptor,
      index,
      quality: Math.max(0, ...descriptor.paths.map(iconPathQuality))
    }))
    .sort((left, right) => right.quality - left.quality || left.index - right.index)
    .map(entry => entry.descriptor)
}

function getUrlHints (manifest, tagName, isValid, normalize) {
  const hints = []
  for (const tag of Array.isArray(manifest?.tags) ? manifest.tags : []) {
    if (!Array.isArray(tag) || tag[0] !== tagName || typeof tag[1] !== 'string') continue
    try {
      if (!isValid(tag[1])) continue
      const hint = normalize(tag[1])
      if (!hints.includes(hint)) hints.push(hint)
      if (hints.length >= MAX_SOURCE_HINTS_PER_TYPE) break
    } catch (_) {}
  }
  return hints
}

export function getManifestFileSourceHints (manifest) {
  return {
    relays: getUrlHints(manifest, 'relay', isValidPublicRelayUrl, normalizeRelayUrl),
    blossomServers: getUrlHints(
      manifest,
      'server',
      isValidPublicBlossomServerUrl,
      normalizeBlossomServerUrl
    )
  }
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
