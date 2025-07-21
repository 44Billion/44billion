import resetCssString from '#assets/styles/reset.css'
import globalCssString from '#assets/styles/global.css'
import { f } from '#f'
import useLocation from '#hooks/use-location.js'
import '#zones/screen/index.js'

document.head.insertAdjacentHTML('beforeend', `<style>${resetCssString}${globalCssString}</style>`)

if (window.IS_DEVELOPMENT) {
  // https://esbuild.github.io/api/#live-reload
  new EventSource('/esbuild').addEventListener('change', () => location.reload())
}

f(function aApp () {
  useLocation({})

  return this.h`
    <a-screen />
  `
})
