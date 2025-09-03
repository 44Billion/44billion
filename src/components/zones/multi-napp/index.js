import { f } from '#f'
import useLocation from '#hooks/use-location.js'
import router from './router.js'
import '#zones/screen/index.js'

f(function multiNapp () {
  useLocation(router)

  return this.h`
    <a-screen />
  `
})
