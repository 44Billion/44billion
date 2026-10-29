import { ResourceServiceError } from '@kehto/services'
import { isValidPublicBlossomServerUrl } from 'libp2r2p/url'
import { verifyBlobHash } from '@kehto/nip/5d'

export const MAX_RESOURCE_BYTES = 16 * 1024 * 1024

export function classifyResource (bytes) {
  const text = new TextDecoder().decode(bytes.slice(0, 16))
  if (bytes[0] === 137 && text.slice(1, 4) === 'PNG') return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) return 'image/gif'
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp'
  if (text.startsWith('wOFF')) return 'font/woff'
  if (text.startsWith('wOF2')) return 'font/woff2'
  if (text.startsWith('ID3') || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return 'audio/mpeg'
  if (text.startsWith('OggS')) return 'audio/ogg'
  if (text.slice(4, 8) === 'ftyp') return 'video/mp4'
  if (bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) return 'video/webm'
  if (text.startsWith('%PDF-')) return 'application/pdf'
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    try { JSON.parse(decoded); return 'application/json' } catch {}
    if (!decoded.includes('\u0000')) return 'text/plain; charset=utf-8'
  } catch {}
  return 'application/octet-stream'
}

// Accept extensionless references too: media sources and existing callers use them.
export function parseBlossomResource (value) {
  const url = new URL(value)
  const match = /^([a-f0-9]{64})(?:\.([a-zA-Z0-9]+))?$/.exec(url.pathname)
  if (url.protocol !== 'blossom:' || !match || url.hash || url.host) throw new ResourceServiceError('invalid-request', 'Invalid Blossom URI')
  const sizes = url.searchParams.getAll('sz')
  if (sizes.length > 1 || (sizes.length && (!/^[1-9][0-9]*$/.test(sizes[0]) || !Number.isSafeInteger(Number(sizes[0]))))) throw new ResourceServiceError('invalid-request', 'Invalid Blossom size')
  const size = sizes.length ? Number(sizes[0]) : undefined
  if (size > MAX_RESOURCE_BYTES) throw new ResourceServiceError('too-large', 'Resource exceeds 16 MiB')
  return { hash: match[1], extension: match[2] || '', size, servers: url.searchParams.getAll('xs'), authors: url.searchParams.getAll('as').filter(author => /^[a-f0-9]{64}$/.test(author)).slice(0, 10) }
}

function isPublicResourceOrigin (url) {
  // The library's Blossom policy requires HTTPS. Reuse its public-host
  // validation for HTTP resources too; browser mixed-content policy still applies.
  const secure = new URL(url.origin)
  secure.protocol = 'https:'
  return isValidPublicBlossomServerUrl(secure.href)
}

function serverOrigins (value) {
  try {
    const urls = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? [new URL(value)] : [new URL(`https://${value}`), new URL(`http://${value}`)]
    return urls.filter(url => ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && isPublicResourceOrigin(url)).map(url => url.origin)
  } catch { return [] }
}

async function discoverServers (load, author, signal) {
  let onAbort
  try {
    return await Promise.race([
      Promise.resolve().then(() => { signal.throwIfAborted(); return load(author, { signal }) }),
      new Promise((resolve, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
    ])
  } finally { signal.removeEventListener('abort', onAbort) }
}

export function createNappletResourceResolver ({ signal, guard = () => {}, fetchBytes = fetch, fallbackServers = [], loadAuthorServers = async () => [] }) {
  return async function resolve (value, init = {}) {
    guard()
    const lifetime = AbortSignal.any([signal, init.signal, AbortSignal.timeout(30000)].filter(Boolean))
    try {
      lifetime.throwIfAborted()
      const url = new URL(value)
      let bytes
      if (url.protocol === 'blossom:') {
        const reference = parseBlossomResource(value)
        const seen = new Set()
        let failure = new ResourceServiceError('not-found', 'Could not download a verified Blossom resource')
        const attempt = async servers => {
          for (const server of servers.slice(0, 10).flatMap(serverOrigins)) {
            lifetime.throwIfAborted()
            guard()
            if (seen.has(server)) continue
            seen.add(server)
            try {
              const response = await resolve(`${server}/${reference.hash}${reference.extension ? `.${reference.extension}` : ''}`, { signal: lifetime, method: 'GET' })
              const candidate = new Uint8Array(await response.arrayBuffer())
              if (!verifyBlobHash(candidate, reference.hash) || (reference.size !== undefined && candidate.length !== reference.size)) {
                failure = new ResourceServiceError('decode-failed', 'Blossom hash or size mismatch')
                continue
              }
              return candidate
            } catch (error) {
              lifetime.throwIfAborted()
              guard()
              failure = error
            }
          }
        }
        bytes = await attempt(reference.servers)
        for (const author of reference.authors) {
          if (bytes) break
          lifetime.throwIfAborted()
          try { bytes = await attempt(await discoverServers(loadAuthorServers, author, lifetime)) } catch (error) { lifetime.throwIfAborted(); guard(); failure = error }
        }
        if (!bytes) bytes = await attempt(init.servers || [])
        if (!bytes) bytes = await attempt(fallbackServers)
        if (!bytes) throw failure
      } else {
        if (!['http:', 'https:'].includes(url.protocol)) throw new ResourceServiceError('unsupported-scheme', 'Unsupported resource scheme')
        if (!isPublicResourceOrigin(url) || url.username || url.password) throw new ResourceServiceError('blocked-by-policy', 'Only public resource origins are allowed')
        // Redirects cannot turn a public request into a request to a local service.
        const response = await fetchBytes(url.href, { method: 'GET', signal: lifetime, credentials: 'omit', redirect: 'error' })
        if (!response.ok) { await response.body?.cancel(); throw new ResourceServiceError(response.status === 404 ? 'not-found' : 'network-error', 'Resource request failed') }
        if (Number(response.headers.get('content-length')) > MAX_RESOURCE_BYTES) { await response.body?.cancel(); throw new ResourceServiceError('too-large', 'Resource exceeds 16 MiB') }
        const reader = response.body.getReader()
        const chunks = []
        let size = 0
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_RESOURCE_BYTES) throw new ResourceServiceError('too-large', 'Resource exceeds 16 MiB')
            chunks.push(value)
          }
        } finally { await reader.cancel() }
        bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      }
      lifetime.throwIfAborted()
      guard()
      return new Response(init.method === 'HEAD' ? null : bytes, { headers: { 'content-type': classifyResource(bytes), 'content-length': String(bytes.byteLength) } })
    } catch (error) {
      if (lifetime.aborted && lifetime.reason?.name === 'TimeoutError') throw new ResourceServiceError('timeout', 'Resource request timed out')
      throw error
    }
  }
}
