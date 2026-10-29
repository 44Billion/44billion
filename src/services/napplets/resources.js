import { ResourceServiceError } from '@kehto/services'
import { isValidPublicBlossomServerUrl } from 'libp2r2p/url'
import { fetchNappletBlob } from './index.js'

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

export function createNappletResourceResolver ({ signal, guard = () => {}, fetchBytes = fetch, fallbackServers = [] }) {
  return async (value, init) => {
    guard()
    const lifetime = AbortSignal.any([signal, init.signal || signal, AbortSignal.timeout(30000)])
    const url = new URL(value)
    let bytes
    if (url.protocol === 'blossom:') {
      const hash = value.slice('blossom:'.length).replace(/^\/\//, '').split(/[/?#]/)[0]
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new ResourceServiceError('invalid-request', 'Invalid Blossom hash')
      bytes = await fetchNappletBlob(hash, init.servers?.length ? init.servers : fallbackServers, { signal: lifetime, maxBytes: MAX_RESOURCE_BYTES })
    } else {
      if (!['http:', 'https:'].includes(url.protocol)) throw new ResourceServiceError('unsupported-scheme', 'Unsupported resource scheme')
      if (!isValidPublicBlossomServerUrl(url.origin) || url.username || url.password) throw new ResourceServiceError('blocked-by-policy', 'Only public resource origins are allowed')
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
  }
}
