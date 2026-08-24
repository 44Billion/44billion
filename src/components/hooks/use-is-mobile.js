import { useSignal, useTask } from '#f'
import { jsVars } from '#assets/styles/theme.js'

export default function useIsMobile () {
  const isMobile$ = useSignal(false)

  useTask(({ cleanup }) => {
    const mql = window.matchMedia(jsVars.breakpoints.mobile)
    const update = () => isMobile$(mql.matches)
    update()
    mql.addEventListener('change', update)
    cleanup(() => mql.removeEventListener('change', update))
  })

  return isMobile$
}
