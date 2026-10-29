import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { decode, naddrEncode, neventEncode } from 'nostr-tools/nip19'
import { getNappletCatalogId, parseNappletManifest, verifyManifestSignature } from '@kehto/nip/5d'

export const NAPPLET_DOMAINS = Object.freeze(['shell', 'storage', 'theme', 'identity', 'outbox', 'relay', 'count', 'resource', 'common', 'lists', 'keys', 'gamepad', 'config', 'notify', 'link', 'media'])
export const isNappletAppId = value => typeof value === 'string' && /^napplet-[0-9a-f]{64}$/.test(value)
export const nappletAppId = catalogId => `napplet-${bytesToHex(sha256(new TextEncoder().encode(catalogId)))}`

export function nappletDescriptor (event) {
  if (!verifyManifestSignature(event)) throw new Error('Invalid napplet manifest signature')
  const manifest = parseNappletManifest(event)
  // Legacy aggregate 35129 events overlap the launcher's existing next channel.
  // Admit only the unambiguous current single-artifact NIP-5D schema here.
  if (manifest.format !== 'current') throw new Error('Only current NIP-5D artifact manifests are supported')
  const catalogId = getNappletCatalogId(event)
  const appId = nappletAppId(catalogId)
  return { appId, catalogId, event, manifest, missing: manifest.requires.filter(domain => !NAPPLET_DOMAINS.includes(domain)) }
}

export function nappletReference (event) {
  if (event.kind === 5129) return neventEncode({ id: event.id })
  return naddrEncode({ kind: event.kind, pubkey: event.pubkey, identifier: event.tags.find(tag => tag[0] === 'd')?.[1] || '' })
}

export function decodeNappletReference (value) {
  const { type, data } = decode(value.replace(/^nostr:/, ''))
  if (type === 'nevent') return { filter: { ids: [data.id], limit: 1 }, relays: data.relays || [] }
  if (type === 'naddr' && [15129, 35129].includes(data.kind)) {
    if (data.kind === 15129 && data.identifier !== '') throw new Error('Root napplets have no identifier')
    return {
      filter: { kinds: [data.kind], authors: [data.pubkey], ...(data.kind === 35129 ? { '#d': [data.identifier] } : {}), limit: 10 },
      relays: data.relays || []
    }
  }
  throw new Error('Expected a napplet naddr or nevent reference')
}

export function nappletReferenceFromHref (href, base = 'https://localhost') {
  const url = new URL(href, base)
  const match = url.pathname.match(/^\/napplet\/([^/]+)\/?$/)
  if (!match) return null
  const reference = decodeURIComponent(match[1])
  decodeNappletReference(reference)
  return reference
}
