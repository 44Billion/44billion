import { useCallback } from '#f'
import useLocation from '#hooks/use-location.js'

export default function useGoBackOrToRoot () {
  const loc = useLocation()
  return useCallback(() => {
    const currentUid = loc.route$().uid
    const isAtFirstUrl = currentUid <= 0

    if (isAtFirstUrl) {
      const isAtRoot = loc.route$().url.pathname === '/' && Object.keys(loc.route$().url.searchParams).length === 0
      return isAtRoot ? loc.back() : loc.replaceState({}, '', '/')
    } else {
      return loc.back()
    }
  })
}
