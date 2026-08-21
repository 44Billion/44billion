import { appEncode } from 'libp2r2p/nip19'
import { resolveUserReference } from 'libp2r2p/nip27'
import { nappRelays } from 'libp2r2p/relay'
import { appUrlKindByChannel, decodeAppUrl } from 'libp2r2p/url'
import { getUserRelays, getSiteManifest } from '#helpers/nostr-queries.js'

// Hardcoded no-account app aliases owned by the 44billion launcher.
const APP_URL_ALIASES = Object.freeze({
  '+app': '+3swFhu23QNl8er5yOtc8bf9ueHCdwF8CzoDUiSSwwKIWoS8Ki5TwMyeA3Js1',
  '+apps': '+3swFhu23QNl8er5yOtc8bf9ueHCdwF8CzoDUiSSwwKIWoS8Ki5TwMyeA3Js1',
  '+appstore': '+3swFhu23QNl8er5yOtc8bf9ueHCdwF8CzoDUiSSwwKIWoS8Ki5TwMyeA3Js1',
  '+app-store': '+3swFhu23QNl8er5yOtc8bf9ueHCdwF8CzoDUiSSwwKIWoS8Ki5TwMyeA3Js1',
  '+app store': '+3swFhu23QNl8er5yOtc8bf9ueHCdwF8CzoDUiSSwwKIWoS8Ki5TwMyeA3Js1'
})

// A raw first path segment is an app URL when it is a NIP-19 app entity,
// a named URL with a user, or one of the hardcoded no-user aliases.
export function isAppUrl (segment) {
  if (typeof segment !== 'string' || !segment) return false
  const decoded = decodeAppUrl(segment)
  if (!decoded) return false
  if (decoded.type === 'entity') return true
  if (decoded.user) return true
  return Object.prototype.hasOwnProperty.call(
    APP_URL_ALIASES,
    `${decoded.prefix}${decoded.appName}`
  )
}

// Resolves a raw first path segment to a canonical NIP-19 app entity.
// Named URLs are resolved through their user reference and site manifest.
export async function resolveAppUrl (segment, {
  signal,
  _getSiteManifest = getSiteManifest,
  _getRelaysByPubkey = getUserRelays,
  _resolveUserReference = resolveUserReference
} = {}) {
  const decoded = decodeAppUrl(segment)
  if (!decoded) return null
  if (decoded.type === 'entity') return decoded.entity

  if (!decoded.user) {
    return APP_URL_ALIASES[`${decoded.prefix}${decoded.appName}`] || null
  }

  try {
    const user = await _resolveUserReference(decoded.user.raw, { signal })
    if (!user) return null

    const kind = appUrlKindByChannel(decoded.channel)
    if (!kind) return null

    const relaysByPubkey = (await _getRelaysByPubkey([user.pubkey]))[user.pubkey]
    const userWriteRelays = relaysByPubkey?.write || []
    const relays = [...new Set([
      ...(user.relays || []),
      ...userWriteRelays,
      ...nappRelays
    ])]

    const manifest = await _getSiteManifest(
      { pubkey: user.pubkey, kind, dTag: decoded.appName },
      { write: relays },
      { signal }
    )
    if (!manifest) return null

    const relayHints = [...new Set([
      ...(user.relays || []),
      ...userWriteRelays
    ])].slice(0, 2)

    return appEncode({
      dTag: decoded.appName,
      pubkey: user.pubkey,
      kind,
      relays: relayHints
    })
  } catch {
    return null
  }
}
