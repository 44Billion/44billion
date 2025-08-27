import resetCssString from '#assets/styles/reset.css'
import globalCssString from '#assets/styles/global.css'
import { f } from '#f'
import useLocation from '#hooks/use-location.js'
import router from './router.js'
import '#zones/screen/index.js'

document.head.insertAdjacentHTML('beforeend', `<style>${resetCssString}${globalCssString}</style>`)

if (window.IS_DEVELOPMENT) {
  // https://esbuild.github.io/api/#live-reload
  new EventSource('/esbuild').addEventListener('change', () => location.reload())
}

f(function aApp () {
  // we rely on us being the top for reusing same
  // key for storage partition
  if (window.location.origin !== window.top.location.origin) return
  useLocation(router)

  return this.h`
    <a-screen />
  `
})
