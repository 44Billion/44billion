export function pruneReadyClients (clients, readyClients) {
  const activeIds = new Set(clients.map(client => client.id))
  for (const id of readyClients.keys()) {
    if (!activeIds.has(id)) readyClients.delete(id)
  }
}

export function findReadyBridgeClient (clients, readyClients, bridgeId = '', { strict = false } = {}) {
  const ready = clients
    .filter(isTrustedClient)
    .map(client => ({
      client,
      readyAt: readyClients.get(client.id)?.readyAt ?? 0
    }))
    .sort((a, b) => b.readyAt - a.readyAt)[0]?.client || null

  if (!bridgeId) return ready

  const matching = clients
    .filter(isTrustedClient)
    .filter(client => readyClients.get(client.id)?.bridgeId === bridgeId)
    .sort((a, b) =>
      (readyClients.get(b.id)?.readyAt ?? 0) -
      (readyClients.get(a.id)?.readyAt ?? 0)
    )[0]

  // When the app page's bridge id is known (e.g. carried in the iframe URL),
  // routing must stay on that tab: never fall back to another tab's trusted
  // iframe. The non-strict fallback remains only for requests that arrive
  // before any bridge id can be associated with the app page.
  return strict ? (matching || null) : (matching || ready)
}

function isTrustedClient (client) {
  try {
    return new URL(client.url).pathname === '/~~napp'
  } catch (_error) {
    return false
  }
}
