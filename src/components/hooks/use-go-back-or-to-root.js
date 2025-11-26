import { useCallback } from '#f'
import useLocation from '#hooks/use-location.js'

export default function useGoBackOrToRoot () {
  const loc = useLocation()
  return useCallback(() => {
    const isAtFirstUrl = !loc.uidCounter$()

    if (isAtFirstUrl) {
      const isAtRoot = loc.route$().url.pathname === '/' && loc.route$().url.searchParams.size === 0
      return isAtRoot ? loc.back() : loc.replaceState({}, '', '/')
    } else return loc.back()
  })
}
