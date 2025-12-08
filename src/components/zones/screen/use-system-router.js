import { useStore } from '#f'
import useLocation from '#hooks/use-location.js'

export default function useSystemRouter () {
  const loc = useLocation()
  return useStore(() => ({
    isSystemRoute$ () { return loc.route$().handler?.mount === 'system-views' }
  }))
}
