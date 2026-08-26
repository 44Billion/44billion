import { useSignal, useTask } from '#f'
import { useWebStorage } from '#f'
import { getRandomId } from '#helpers/misc.js'
import { useActiveWorkspaceOrder } from '#hooks/use-active-workspace-order.js'
import {
  ackStickySessionDeletion,
  commitStickySnapshot,
  collectValidAppKeys,
  heartbeatStickyClaim,
  releaseStickyClaim,
  removeStickySession,
  STICKY_CLAIM_HEARTBEAT_MS,
  STICKY_SNAPSHOT_DEBOUNCE_MS,
  buildSnapshotFromDraft
} from '#services/sticky-sessions/index.js'

export default function useStickySessionSnapshotter () {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)
  const { order$ } = useActiveWorkspaceOrder(storage, tabStorage)
  const hidden$ = useSignal(document.hidden)

  useTask(({ cleanup }) => {
    const onVisibilityChange = () => hidden$(document.hidden)
    document.addEventListener('visibilitychange', onVisibilityChange)
    cleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange))
  })

  useTask(({ track, cleanup }) => {
    const enabled = track(() => storage.config_stickySessions$())
    if (!enabled) return

    let tabId = tabStorage.session_stickyTabId$()
    if (!tabId) {
      tabId = getRandomId()
      tabStorage.session_stickyTabId$(tabId)
    }

    const hidden = track(() => hidden$())
    const workspaceKeys = track(() => storage.session_workspaceKeys$()) ?? []

    // A deletion tombstone for this tab's snapshot means the session was
    // deleted from another tab: close every app instance here, acknowledge,
    // and rotate the tab id so future opens create a fresh session instead of
    // resurrecting the deleted snapshot under the same identifier.
    const deletions = track(() => storage.local_stickySessionDeletions$()) ?? {}
    if (deletions[tabId]) {
      for (const wsKey of workspaceKeys) {
        const appKeys = [...collectValidAppKeys(localStorage, wsKey)]
        for (const appKey of appKeys) {
          tabStorage[`session_appByKey_${appKey}_visibility$`]('closed')
        }
        tabStorage[`session_workspaceByKey_${wsKey}_openAppKeys$`]([])
      }
      removeStickySession({ localStorageArea: localStorage, snapshotId: tabId })
      ackStickySessionDeletion({ localStorageArea: localStorage, snapshotId: tabId })
      releaseStickyClaim({ localStorageArea: localStorage, tabId })
      tabStorage.session_stickyTabId$(undefined)
      return
    }

    const order = track(() => order$())
    const byWorkspace = {}
    for (const wsKey of workspaceKeys) {
      const openKeys = track(() => tabStorage[`session_workspaceByKey_${wsKey}_openAppKeys$`]()) ?? []
      const appKeys = [...collectValidAppKeys(localStorage, wsKey)]
      const visibility = {}
      const routes = {}
      for (const appKey of appKeys) {
        visibility[appKey] = track(() => tabStorage[`session_appByKey_${appKey}_visibility$`]())
        routes[appKey] = track(() => storage[`session_appByKey_${appKey}_route$`]())
      }
      byWorkspace[wsKey] = {
        openKeys,
        minimizedKeys: appKeys.filter(key => visibility[key] === 'minimized'),
        visibility,
        routes
      }
    }

    let commitTimer = null
    const scheduleCommit = () => {
      if (commitTimer) clearTimeout(commitTimer)
      commitTimer = setTimeout(() => {
        commitTimer = null
        if (document.hidden) return
        const snapshot = buildSnapshotFromDraft({ workspaceKeys: order, byWorkspace })
        commitStickySnapshot({
          localStorageArea: localStorage,
          tabId,
          snapshot,
          now: Date.now()
        })
      }, STICKY_SNAPSHOT_DEBOUNCE_MS)
    }

    if (!hidden) scheduleCommit()

    const heartbeat = setInterval(() => {
      heartbeatStickyClaim({
        localStorageArea: localStorage,
        tabId,
        now: Date.now()
      })
    }, STICKY_CLAIM_HEARTBEAT_MS)

    const onPageHide = () => {
      if (document.hidden) return
      const snapshot = buildSnapshotFromDraft({ workspaceKeys: order, byWorkspace })
      commitStickySnapshot({
        localStorageArea: localStorage,
        tabId,
        snapshot,
        now: Date.now()
      })
      releaseStickyClaim({ localStorageArea: localStorage, tabId })
    }
    window.addEventListener('pagehide', onPageHide)

    cleanup(() => {
      if (commitTimer) clearTimeout(commitTimer)
      clearInterval(heartbeat)
      window.removeEventListener('pagehide', onPageHide)
    })
  })
}
