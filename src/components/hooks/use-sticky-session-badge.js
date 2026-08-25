import { useComputed } from '#f'
import { useWebStorage } from '#f'
import {
  LOCAL_STICKY_CLAIMS,
  LOCAL_STICKY_SEEN_IDS,
  LOCAL_STICKY_SNAPSHOTS,
  unseenUnclaimedCount
} from '#services/sticky-sessions/index.js'

export default function useStickySessionBadgeCount () {
  const storage = useWebStorage(localStorage)
  const snapshots$ = storage[`${LOCAL_STICKY_SNAPSHOTS}$`]
  const claims$ = storage[`${LOCAL_STICKY_CLAIMS}$`]
  const seenIds$ = storage[`${LOCAL_STICKY_SEEN_IDS}$`]

  return useComputed(() => unseenUnclaimedCount({
    snapshots: snapshots$() ?? {},
    claims: claims$() ?? {},
    seenIds: seenIds$() ?? [],
    now: Date.now()
  }))
}
