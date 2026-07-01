import { enqueueVaultAcceptedMessage } from '#helpers/window-message/browser/vault-accepted-message-queue.js'
import { flushQueuedVaultAcceptedMessages } from '#zones/vault-modal/index.js'
import { NOSTRDB_APP_BACKFILL_CODE, workspaceOwnerPubkey } from './nostrdb-app-lifecycle.js'

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
