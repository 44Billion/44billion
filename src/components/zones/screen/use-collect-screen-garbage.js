import { useTask } from '#f'
import useWebStorage from '#hooks/use-web-storage.js'

export default function useCollectScreenGarbage () {
  const storage = useWebStorage(localStorage)
  const {
    session_openWorkspaceKeys$: openWorkspaceKeys$
  } = storage

  useTask(() => {
    let wsKey, openAppKeys$
    for (wsKey of openWorkspaceKeys$()) {
      ({
        [`session_workspaceByKey_${wsKey}_openAppKeys$`]: openAppKeys$
      } = storage)

      // During session, domOrder can only push items
      // Even if apps get closed, they don't leave it,
      // thus getting out of sync
      openAppKeys$(v => {
        const invisibleAppKeys = v.domOrder
          .filter(appKey => storage[`session_appByKey_${appKey}_visibility$`]() === 'minimized')
          // openAppKeys$ and visibility$ change together but not on an atomic operation
          .filter(v2 => !v.cssOrder.includes(v2))
        v.domOrder = [...v.cssOrder, ...invisibleAppKeys]
        return v
      })
    }
  })
}
