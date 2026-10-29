import { verifyEvent } from '../event-verification.js'
import { npubEncode } from 'nostr-tools/nip19'
import { verifyBlobHash } from '@kehto/nip/5d'
import { getProfileEventsByPubkey } from '#helpers/nostr-queries.js'
import { fetchNappletBlob } from './index.js'

export const MAX_NAPPLET_ICON_BYTES = 512 * 1024

function matchesIconMime (bytes, mime) {
  if (mime === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  return new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
}

export function nappletAuthorLabel (pubkey, profiles = {}) {
  const profile = profiles[pubkey]
  const name = [profile?.display_name, profile?.name].find(value => typeof value === 'string' && value.trim())
  if (name) return name.trim().slice(0, 100)
  const npub = npubEncode(pubkey)
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`
}

export async function loadNappletAuthors (pubkeys, { signal, fetchProfiles = getProfileEventsByPubkey } = {}) {
  const authors = [...new Set(pubkeys)]
  const allowed = new Set(authors)
  const events = await fetchProfiles(authors, { signal })
  signal?.throwIfAborted()
  const profiles = {}
  const seen = new Set()
  for (const event of [...events].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))) {
    try {
      if (event.kind !== 0 || !allowed.has(event.pubkey) || seen.has(event.pubkey) || !verifyEvent(event)) continue
      // The newest signed profile is authoritative even when its JSON is invalid.
      seen.add(event.pubkey)
      const profile = JSON.parse(event.content)
      if (profile && typeof profile === 'object' && !Array.isArray(profile)) profiles[event.pubkey] = profile
    } catch {}
  }
  return profiles
}

// Only hash-verified, supported raster formats reach the browser decoder.
// URLs remain in memory and are released by the catalog's lifecycle.
export async function createNappletIconUrl (manifest, {
  signal, fetchBlob = fetchNappletBlob,
  decode = blob => createImageBitmap(blob), createUrl = blob => URL.createObjectURL(blob)
} = {}) {
  const icon = manifest.icon
  if (!icon) return null
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(icon.mimeType)) throw new Error('Unsupported napplet icon format')
  const bytes = await fetchBlob(icon.sha256, manifest.servers, { signal, maxBytes: MAX_NAPPLET_ICON_BYTES })
  signal?.throwIfAborted()
  if (bytes.byteLength > MAX_NAPPLET_ICON_BYTES || !verifyBlobHash(bytes, icon.sha256) || !matchesIconMime(bytes, icon.mimeType)) throw new Error('Invalid napplet icon bytes')
  const blob = new Blob([bytes], { type: icon.mimeType })
  const bitmap = await decode(blob)
  try {
    signal?.throwIfAborted()
    if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 2048 || bitmap.height > 2048) throw new Error('Napplet icon dimensions exceed the limit')
  } finally { bitmap.close() }
  return createUrl(blob)
}
