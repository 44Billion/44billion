import { useCallback, useGlobalSignal, useStore, useTask } from '#f'
import { useLocation } from '#f'

export default function useSystemRouter () {
  const loc = useLocation()
  const lastNonSystemUid$ = useGlobalSignal(
    'useSystemRouter_lastNonSystemUid',
    () => 0,
    { shouldCache: false }
  )

  useTask(({ track }) => {
    const route = track(() => loc.route$())
    if (route.handler?.mount !== 'system-views') {
      lastNonSystemUid$(route.uid)
    }
  })

  const closeSystemViews = useCallback(() => {
    const route = loc.route$()
    if (route.handler?.mount !== 'system-views') return

    if (route.uid <= 0) {
      loc.replaceState({}, '', '/')
      return
    }

    const depth = Math.max(1, route.uid - lastNonSystemUid$())
    loc.go(-depth)
  })

  return useStore(() => ({
    isSystemRoute$ () { return loc.route$().handler?.mount === 'system-views' },
    closeSystemViews
  }))
}
