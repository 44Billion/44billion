export function pruneReadyClients (clients, readyClients) {
  const activeIds = new Set(clients.map(client => client.id))
  for (const id of readyClients.keys()) {
    if (!activeIds.has(id)) readyClients.delete(id)
  }
}

export function findReadyBridgeClient (clients, readyClients, clientId) {
  const requester = clients.find(client => client.id === clientId)
  const requesterWindowId = requester
    ? getClientWindowId(requester)
    : ''

  return clients.find(client => {
    if (!isTrustedClient(client)) return false
    const entry = readyClients.get(client.id)
    if (!entry) return false
    if (requesterWindowId) return entry.windowId === requesterWindowId
    return true
  }) || null
}

function isTrustedClient (client) {
  try {
    return new URL(client.url).pathname === '/~~napp'
  } catch (_error) {
    return false
  }
}

export function getClientWindowId (client) {
  try {
    return new URL(client.url).searchParams.get('windowId') || ''
  } catch (_error) {
    return ''
  }
}
