import { nfileDecode } from 'libp2r2p/nip19'

export function parseNfileUrl (value) {
  const url = new URL(value)
  if (url.origin !== 'https://nostr.alt' || url.username || url.password || url.hash || !/^\/nfile1[ac-hj-np-z02-9]+$/.test(url.pathname)) throw new Error('INVALID_NFILE_URL')
  if ([...url.searchParams].some(([key, value]) => key !== 'localOnly' || value !== '1') || url.searchParams.getAll('localOnly').length > 1) throw new Error('INVALID_NFILE_URL')
  const entity = url.pathname.slice(1)
  return { entity, reference: nfileDecode(entity), localOnly: url.searchParams.get('localOnly') === '1' }
}

export function fileDownloadUrl (value, { origin, bridgeId }) {
  const { entity, localOnly } = parseNfileUrl(value)
  if (!bridgeId) throw new Error('APP_BRIDGE_UNAVAILABLE')
  const url = new URL(`/~~nfile/${entity}`, origin)
  if (localOnly) url.searchParams.set('localOnly', '1')
  url.searchParams.set('~~bridgeId', bridgeId)
  return url.href
}

export function attachmentHeaders (headers) {
  const result = new Headers(headers)
  const disposition = result.get('content-disposition') || 'inline'
  result.set('content-disposition', disposition.replace(/^inline/, 'attachment'))
  result.set('x-content-type-options', 'nosniff')
  result.set('cache-control', 'no-store')
  return result
}
