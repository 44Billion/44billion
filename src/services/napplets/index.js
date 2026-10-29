import { resolveNapplet, verifyBlobHash } from '@kehto/nip/5d'
import { nappRelays, freeRelays, relayPool } from 'libp2r2p/relay'
import { isValidPublicRelayUrl, isValidPublicBlossomServerUrl } from 'libp2r2p/url'
import { nappletDescriptor, decodeNappletReference } from '#helpers/napplet.js'
import { getInstallation, listInstallations, addInstallation } from './storage.js'

export const MAX_NAPPLET_BYTES = 8 * 1024 * 1024
export const NAPPLET_DISCOVERY_RELAYS = Object.freeze([...new Set([...nappRelays, ...freeRelays])])

function matchesReference (event, filter) {
  return filter.ids
    ? filter.ids.includes(event?.id)
    : event?.kind === filter.kinds[0] && event.pubkey === filter.authors[0] && (event.kind !== 35129 || event.tags?.find(tag => tag[0] === 'd')?.[1] === filter['#d'][0])
}

export async function fetchNappletBlob (hash, servers, { signal, maxBytes = MAX_NAPPLET_BYTES } = {}) {
  for (const server of servers.slice(0, 10)) {
    if (!isValidPublicBlossomServerUrl(server)) continue
    try {
      const response = await fetch(`${server.replace(/\/$/, '')}/${hash}`, {
        signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]),
        credentials: 'omit', redirect: 'error', cache: 'no-store'
      })
      if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); continue }
      const reader = response.body.getReader()
      const parts = []
      let size = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxBytes) throw new Error('Napplet asset exceeds its byte limit')
          parts.push(value)
        }
      } finally { await reader.cancel() }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
      if (!verifyBlobHash(bytes, hash)) continue
      return bytes
    } catch (error) { if (signal?.aborted) throw error }
  }
  throw new Error('Could not download a verified napplet artifact')
}

export async function resolveNappletReference (reference, { signal, idb, pool = relayPool } = {}) {
  const { filter, relays } = decodeNappletReference(reference)
  const installed = (await listInstallations(idb)).find(({ event }) => matchesReference(event, filter))
  if (installed) return nappletDescriptor(installed.event)
  const response = await pool.getEvents(filter, [...new Set([...relays.filter(isValidPublicRelayUrl).slice(0, 4), ...NAPPLET_DISCOVERY_RELAYS])], { signal, timeout: 10000 })
  const events = (response.result || []).map(item => item.event).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
  for (const event of events) {
    try { if (matchesReference(event, filter)) return nappletDescriptor(event) } catch {}
  }
  throw new Error('No valid napplet manifest found')
}

export async function installNapplet (event, { signal, fetchBlob = fetchNappletBlob, idb } = {}) {
  const descriptor = nappletDescriptor(event)
  const existing = await getInstallation(descriptor.appId, idb)
  // Opening an installed coordinate stays on the selected version.
  if (existing) return descriptor.appId
  const blobs = new Map()
  let total = 0
  await resolveNapplet({
    event, fetchBlob: async (hash, servers) => {
      const bytes = await fetchBlob(hash, servers, { signal })
      total += bytes.byteLength
      if (total > MAX_NAPPLET_BYTES) throw new Error('Napplet installation exceeds 8 MiB')
      blobs.set(hash, bytes)
      return bytes
    }
  })
  signal?.throwIfAborted()
  try {
    await addInstallation({ appId: descriptor.appId, event, blobs: [...blobs], installedAt: Date.now() }, idb)
  } catch (error) {
    // Another tab may have completed the same coordinate while bytes loaded.
    // Retain that first selected version rather than replacing it implicitly.
    if (error.name !== 'ConstraintError') throw error
  }
  return descriptor.appId
}

export async function loadNapplet (appId, { idb } = {}) {
  const record = await getInstallation(appId, idb)
  if (!record || nappletDescriptor(record.event).appId !== appId) throw new Error('Napplet installation is missing or invalid')
  const blobs = new Map(record.blobs)
  return resolveNapplet({
    event: record.event, fetchBlob: async hash => {
      if (!blobs.has(hash)) throw new Error('Installed napplet artifact is missing')
      return blobs.get(hash)
    }
  })
}

export async function queryNappletCatalog ({ signal, pool = relayPool } = {}) {
  const response = await pool.getEvents({ kinds: [15129, 35129, 5129], limit: 100 }, NAPPLET_DISCOVERY_RELAYS, { signal, timeout: 10000 })
  if (!response.success) throw new Error('Could not load the napplet catalog')
  const entries = new Map()
  for (const { event } of (response.result || []).sort((a, b) => b.event.created_at - a.event.created_at || a.event.id.localeCompare(b.event.id))) {
    try {
      const descriptor = nappletDescriptor(event)
      if (!entries.has(descriptor.appId)) entries.set(descriptor.appId, descriptor)
    } catch {}
  }
  return [...entries.values()]
}
