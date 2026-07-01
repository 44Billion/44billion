import { base62ToBase16 } from '#helpers/base62.js'
import { enqueueVaultAcceptedMessage } from '#helpers/window-message/browser/vault-accepted-message-queue.js'
import { flushQueuedVaultAcceptedMessages } from '#zones/vault-modal/index.js'

const HEX32 = /^[0-9a-f]{64}$/i
const NOSTRDB_APP_BACKFILL_CODE = 'NOSTRDB_APP_BACKFILL'

function workspaceOwnerPubkey (storage, wsKey) {
  const userPk = storage?.[`session_workspaceByKey_${wsKey}_userPk$`]?.()
  if (!userPk || userPk === storage?.session_defaultUserPk$?.()) return ''
  try {
    const pubkey = base62ToBase16(userPk).toLowerCase()
    return HEX32.test(pubkey) ? pubkey : ''
  } catch {
    return ''
  }
}

export function requestNostrDbAppBackfillForWorkspace ({ storage, wsKey, appId }) {
  const ownerPubkey = workspaceOwnerPubkey(storage, wsKey)
  if (!ownerPubkey || !appId) return false
  const queued = enqueueVaultAcceptedMessage({
    code: NOSTRDB_APP_BACKFILL_CODE,
    payload: { ownerPubkey, appId }
  })
  if (queued) {
    flushQueuedVaultAcceptedMessages()
      .catch(err => console.warn('Failed to flush queued vault message', err))
  }
  return queued
}

export function requestNostrDbAppBackfillsForWorkspace ({ storage, wsKey, appIds }) {
  let requested = 0
  for (const appId of Array.isArray(appIds) ? appIds : []) {
    if (requestNostrDbAppBackfillForWorkspace({ storage, wsKey, appId })) requested++
  }
  return requested
}
